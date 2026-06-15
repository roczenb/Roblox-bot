const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const mongoose = require('mongoose');
const axios = require('axios');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages] });

const DB = {
    User: mongoose.model('U', new mongoose.Schema({ discordId: String, robloxId: String })),
    Group: mongoose.model('G', new mongoose.Schema({ guildId: String, groupId: String })),
    Bind: mongoose.model('B', new mongoose.Schema({ guildId: String, groupId: String, rankId: Number, roleId: String }))
};

const commands = [
    new SlashCommandBuilder().setName('verify').setDescription('Link Roblox').addStringOption(o => o.setName('username').setDescription('Username').setRequired(true)),
    new SlashCommandBuilder().setName('setup-group').setDescription('Link Group ID').addStringOption(o => o.setName('groupid').setDescription('Group ID').setRequired(true)),
    new SlashCommandBuilder().setName('sync-group-roles').setDescription('Auto create all group roles'),
    new SlashCommandBuilder().setName('bind').setDescription('Bind rank').addIntegerOption(o => o.setName('rankid').setDescription('Rank').setRequired(true)).addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)),
    new SlashCommandBuilder().setName('update').setDescription('Sync ranks')
].map(c => c.toJSON());

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    try {
        await new REST({ version: '10' }).setToken(process.env.BOT_TOKEN).put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('Commands deployed!');
    } catch (e) { console.error(e); }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, options, guildId, member } = interaction;

    // --- VERIFY ---
    if (commandName === 'verify') {
        await interaction.deferReply();
        try {
            const res = await axios.post('https://users.roproxy.com/v1/usernames/users', { usernames: [options.getString('username')], excludeBannedUsers: true });
            if (!res.data.data.length) return interaction.editReply("❌ User not found.");
            const rId = res.data.data[0].id;
            await DB.User.findOneAndUpdate({ discordId: interaction.user.id }, { robloxId: rId }, { upsert: true });
            return interaction.editReply(`✅ Verified as Roblox ID: ${rId}`);
        } catch (e) { return interaction.editReply(`❌ Error: ${e.message}`); }
    }

    // --- SETUP GROUP (Added Defer to fix timeout) ---
    if (commandName === 'setup-group') {
        if (!member.permissions.has('Administrator')) return interaction.reply("❌ Admins only.");
        await interaction.deferReply();
        try {
            await DB.Group.findOneAndUpdate({ guildId }, { groupId: options.getString('groupid') }, { upsert: true });
            return interaction.editReply("✅ Group linked successfully.");
        } catch (e) { return interaction.editReply(`❌ Error: ${e.message}`); }
    }

    // --- SYNC GROUP ROLES ---
    if (commandName === 'sync-group-roles') {
        if (!member.permissions.has('Administrator')) return interaction.reply("❌ Admins only.");
        await interaction.deferReply();
        const conf = await DB.Group.findOne({ guildId });
        if (!conf) return interaction.editReply("❌ Run /setup-group first.");
        try {
            const rRoles = (await axios.get(`https://groups.roproxy.com/v1/groups/${conf.groupId}/roles`)).data.roles.filter(r => r.rank > 0);
            let count = 0;
            for (const r of rRoles) {
                if (!(await DB.Bind.findOne({ guildId, groupId: conf.groupId, rankId: r.rank }))) {
                    const role = await interaction.guild.roles.create({ name: r.name, reason: 'Auto-sync' });
                    await DB.Bind.create({ guildId, groupId: conf.groupId, rankId: r.rank, roleId: role.id });
                    count++;
                }
            }
            return interaction.editReply(`🎉 Created and bound ${count} roles.`);
        } catch (e) { return interaction.editReply(`❌ Sync fail: ${e.message}`); }
    }

    // --- BIND (Added Defer to fix timeout) ---
    if (commandName === 'bind') {
        if (!member.permissions.has('Administrator')) return interaction.reply("❌ Admins only.");
        await interaction.deferReply();
        try {
            const conf = await DB.Group.findOne({ guildId });
            if (!conf) return interaction.editReply("❌ Run /setup-group first.");
            await DB.Bind.create({ guildId, groupId: conf.groupId, rankId: options.getInteger('rankid'), roleId: options.getRole('role').id });
            return interaction.editReply("✅ Rank bound.");
        } catch (e) { return interaction.editReply(`❌ Error: ${e.message}`); }
    }

    // --- UPDATE ---
    if (commandName === 'update') {
        await interaction.deferReply();
        const u = await DB.User.findOne({ discordId: interaction.user.id });
        if (!u) return interaction.editReply("❌ Run /verify first.");
        try {
            const binds = await DB.Bind.find({ guildId });
            if (!binds.length) return interaction.editReply("❌ No roles bound.");
            let added = [];
            const gRes = await axios.get(`https://groups.roproxy.com/v2/users/${u.robloxId}/groups/roles`);
            for (const b of binds) {
                const match = gRes.data.data.find(g => g.group.id.toString() === b.groupId);
                const rank = match ? match.role.rank : 0;
                const role = interaction.guild.roles.cache.get(b.roleId);
                if (role) {
                    if (rank === b.rankId && !member.roles.cache.has(role.id)) { await member.roles.add(role); added.push(role.name); }
                    else if (rank !== b.rankId && member.roles.cache.has(role.id)) { await member.roles.remove(role); }
                }
            }
            return interaction.editReply(`🔄 Sync complete. Added: ${added.join(', ') || 'None'}`);
        } catch (e) { return interaction.editReply("❌ Update network error."); }
    }
});

// Start DB before logging into Discord to prevent early command triggers
const fallbackURI = "mongodb+srv://publicBotUser:BotPass123!@cluster0.whv9s.mongodb.net/robloxBot?retryWrites=true&w=majority";
mongoose.connect(process.env.MONGO_URL || fallbackURI)
    .then(() => {
        console.log("DB Connected!");
        client.login(process.env.BOT_TOKEN);
    })
    .catch(e => console.log("Critical boot error: ", e.message));
