const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const mongoose = require('mongoose');
const axios = require('axios');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages] });

const UserSchema = new mongoose.Schema({ discordId: { type: String, required: true, unique: true }, robloxId: { type: String, required: true } });
const VerifiedUser = mongoose.model('VerifiedUser', UserSchema);

const GuildGroupSchema = new mongoose.Schema({ guildId: { type: String, required: true, unique: true }, groupId: { type: String, required: true } });
const GuildGroup = mongoose.model('GuildGroup', GuildGroupSchema);

const BindSchema = new mongoose.Schema({ guildId: { type: String, required: true }, groupId: { type: String, required: true }, rankId: { type: Number, required: true }, roleId: { type: String, required: true } });
const RoleBind = mongoose.model('RoleBind', BindSchema);

const commands = [
    new SlashCommandBuilder().setName('verify').setDescription('Link your Roblox account').addStringOption(o => o.setName('username').setDescription('Roblox Username').setRequired(true)),
    new SlashCommandBuilder().setName('setup-group').setDescription('Link your Roblox Group ID').addStringOption(o => o.setName('groupid').setDescription('Group ID').setRequired(true)),
    new SlashCommandBuilder().setName('sync-group-roles').setDescription('Admin Only: Automatically create and bind Discord roles for every Roblox group rank'),
    new SlashCommandBuilder().setName('bind').setDescription('Manually bind a rank').addIntegerOption(o => o.setName('rankid').setDescription('Rank (1-255)').setRequired(true)).addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)),
    new SlashCommandBuilder().setName('update').setDescription('Sync your ranks')
].map(c => c.toJSON());

client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    if (process.env.MONGO_URL) await mongoose.connect(process.env.MONGO_URL);
    const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
    try { await rest.put(Routes.applicationCommands(client.user.id), { body: commands }); } catch (e) { console.error(e); }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, options, guildId, member } = interaction;

    if (commandName === 'verify') {
        await interaction.deferReply();
        try {
            const res = await axios.post('https://users.roblox.com/v1/usernames/users', { usernames: [options.getString('username')], excludeBannedUsers: true });
            if (!res.data.data.length) return interaction.editReply("❌ That Roblox username does not exist.");
            await VerifiedUser.findOneAndUpdate({ discordId: interaction.user.id }, { robloxId: res.data.data[0].id }, { upsert: true });
            return interaction.editReply("✅ Verification Successful! Run `/update` to get roles.");
        } catch (e) { return interaction.editReply("❌ Verification error."); }
    }

    if (commandName === 'setup-group') {
        if (!member.permissions.has('Administrator')) return interaction.reply({ content: "❌ Admins only.", ephemeral: true });
        await GuildGroup.findOneAndUpdate({ guildId: guildId }, { groupId: options.getString('groupid') }, { upsert: true });
        return interaction.reply(`✅ Group Linked! You can now use \`/bind\` or \`/sync-group-roles\`.`);
    }

    // --- NEW: AUTO SCAN & CREATE ROLES COMMAND ---
    if (commandName === 'sync-group-roles') {
        if (!member.permissions.has('Administrator')) return interaction.reply({ content: "❌ Admins only.", ephemeral: true });
        await interaction.deferReply();

        const config = await GuildGroup.findOne({ guildId: guildId });
        if (!config) return interaction.editReply("❌ Please run \`/setup-group\` first!");

        try {
            // Fetch all roles directly from Roblox API
            const robloxRolesRes = await axios.get(`https://groups.roblox.com/v1/groups/${config.groupId}/roles`);
            const robloxRoles = robloxRolesRes.data.roles.filter(r => r.rank > 0); // Exclude guests (rank 0)

            let createdCount = 0;

            for (const robloxRole of robloxRoles) {
                // Check if a database bind already exists for this rank to avoid duplicates
                const existingBind = await RoleBind.findOne({ guildId: guildId, groupId: config.groupId, rankId: robloxRole.rank });
                
                if (!existingBind) {
                    // Create the actual role inside the Discord Guild
                    const newDiscordRole = await interaction.guild.roles.create({
                        name: robloxRole.name,
                        reason: `Auto-generated from Roblox Group Rank ${robloxRole.rank}`
                    });

                    // Save the link into the database
                    await RoleBind.create({
                        guildId: guildId,
                        groupId: config.groupId,
                        rankId: robloxRole.rank,
                        roleId: newDiscordRole.id
                    });
                    createdCount++;
                }
            }

            return interaction.editReply(`🎉 **Sync Complete!** Automatically created and mapped **${createdCount}** new roles based on your Roblox group hierarchy.`);
        } catch (e) {
            console.error(e);
            return interaction.editReply("❌ Failed to fetch group ranks from Roblox or create server roles.");
        }
    }

    if (commandName === 'bind') {
        if (!member.permissions.has('Administrator')) return interaction.reply({ content: "❌ Admins only.", ephemeral: true });
        const config = await GuildGroup.findOne({ guildId: guildId });
        if (!config) return interaction.reply({ content: "❌ Run \`/setup-group\` first!", ephemeral: true });
        await RoleBind.create({ guildId: guildId, groupId: config.groupId, rankId: options.getInteger('rankid'), roleId: options.getRole('role').id });
        return interaction.reply(`✅ Successfully bound Rank to role!`);
    }

    if (commandName === 'update') {
        await interaction.deferReply();
        const userData = await VerifiedUser.findOne({ discordId: interaction.user.id });
        if (!userData) return interaction.editReply("❌ Run `/verify` first.");
        try {
            const serverBinds = await RoleBind.find({ guildId: guildId });
            if (!serverBinds.length) return interaction.editReply("❌ No roles are bound yet.");
            let added = [], removed = [];
            const groupRes = await axios.get(`https://groups.roblox.com/v2/users/${userData.robloxId}/groups/roles`);
            for (const b of serverBinds) {
                const match = groupRes.data.data.find(g => g.group.id.toString() === b.groupId);
                const currentRank = match ? match.role.rank : 0;
                const targetRole = interaction.guild.roles.cache.get(b.roleId);
                if (targetRole) {
                    if (currentRank === b.rankId && !member.roles.cache.has(targetRole.id)) {
                        await member.roles.add(targetRole); added.push(targetRole.name);
                    } else if (currentRank !== b.rankId && member.roles.cache.has(targetRole.id)) {
                        await member.roles.remove(targetRole); removed.push(targetRole.name);
                    }
                }
            }
            return interaction.editReply(`🔄 **Updated!** Added: ${added.join(', ') || 'None'} | Removed: ${removed.join(', ') || 'None'}`);
        } catch (e) { return interaction.editReply("❌ Network error updating ranks."); }
    }
});

client.login(process.env.BOT_TOKEN);
