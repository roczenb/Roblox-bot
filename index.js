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
    new SlashCommandBuilder().setName('bind').setDescription('Bind rank to role').addIntegerOption(o => o.setName('rankid').setDescription('Rank (1-255)').setRequired(true)).addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)),
    new SlashCommandBuilder().setName('update').setDescription('Sync your ranks')
].map(c => c.toJSON());

client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    if (process.env.MONGO_URL) {
        await mongoose.connect(process.env.MONGO_URL);
        console.log("Connected seamlessly to MongoDB Database.");
    }
    const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('Successfully reloaded application (/) commands globally.');
    } catch (e) { console.error(e); }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, options, guildId, member } = interaction;

    if (commandName === 'verify') {
        await interaction.deferReply();
        try {
            const res = await axios.post('https://users.roblox.com/v1/usernames/users', { usernames: [options.getString('username')], excludeBannedUsers: true });
            if (!res.data.data.length) return interaction.editReply("❌ That Roblox username does not exist.");
            const rId = res.data.data[0].id;
            await VerifiedUser.findOneAndUpdate({ discordId: interaction.user.id }, { robloxId: rId }, { upsert: true });
            return interaction.editReply("✅ Verification Successful! Run `/update` to get roles.");
        } catch (e) { return interaction.editReply("❌ Verification error."); }
    }

    if (commandName === 'setup-group') {
        if (!member.permissions.has('Administrator')) return interaction.reply({ content: "❌ Admins only.", ephemeral: true });
        await GuildGroup.findOneAndUpdate({ guildId: guildId }, { groupId: options.getString('groupid') }, { upsert: true });
        return interaction.reply(`✅ Group Linked! You can now use \`/bind\`.`);
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
