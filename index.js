const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages] });

// Self-contained Local File Storage (No Cloud DB Required)
const DB_FILE = path.join(__dirname, 'bot_data.json');
let data = { users: {}, groups: {}, binds: {} };

function loadData() {
    try {
        if (fs.existsSync(DB_FILE)) {
            data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        }
    } catch (e) { console.log("Local DB initialization fallback."); }
}

function saveData() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    } catch (e) { console.error("Failed to write data:", e); }
}

loadData();

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
        console.log('Commands deployed completely!');
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
            
            data.users[interaction.user.id] = rId;
            saveData();

            return interaction.editReply(`✅ Verified as Roblox ID: ${rId}`);
        } catch (e) { return interaction.editReply(`❌ Error: ${e.message}`); }
    }

    // --- SETUP GROUP ---
    if (commandName === 'setup-group') {
        if (!member.permissions.has('Administrator')) return interaction.reply("❌ Admins only.");
        await interaction.deferReply();
        
        data.groups[guildId] = options.getString('groupid');
        saveData();
        
        return interaction.editReply("✅ Group linked successfully.");
    }

    // --- SYNC GROUP ROLES ---
    if (commandName === 'sync-group-roles') {
        if (!member.permissions.has('Administrator')) return interaction.reply("❌ Admins only.");
        await interaction.deferReply();
        
        const gId = data.groups[guildId];
        if (!gId) return interaction.editReply("❌ Run /setup-group first.");
        
        try {
            const rRoles = (await axios.get(`https://groups.roproxy.com/v1/groups/${gId}/roles`)).data.roles.filter(r => r.rank > 0);
            let count = 0;
            
            if (!data.binds[guildId]) data.binds[guildId] = [];

            for (const r of rRoles) {
                const exists = data.binds[guildId].some(b => b.groupId === gId && b.rankId === r.rank);
                if (!exists) {
                    const role = await interaction.guild.roles.create({ name: r.name, reason: 'Auto-sync' });
                    data.binds[guildId].push({ groupId: gId, rankId: r.rank, roleId: role.id });
                    count++;
                }
            }
            saveData();
            return interaction.editReply(`🎉 Created and bound ${count} roles.`);
        } catch (e) { return interaction.editReply(`❌ Sync fail: ${e.message}`); }
    }

    // --- BIND ---
    if (commandName === 'bind') {
        if (!member.permissions.has('Administrator')) return interaction.reply("❌ Admins only.");
        await interaction.deferReply();
        
        const gId = data.groups[guildId];
        if (!gId) return interaction.editReply("❌ Run /setup-group first.");
        
        if (!data.binds[guildId]) data.binds[guildId] = [];
        data.binds[guildId].push({
            groupId: gId,
            rankId: options.getInteger('rankid'),
            roleId: options.getRole('role').id
        });
        saveData();
        
        return interaction.editReply("✅ Rank bound.");
    }

    // --- UPDATE ---
    if (commandName === 'update') {
        await interaction.deferReply();
        
        const robloxId = data.users[interaction.user.id];
        if (!robloxId) return interaction.editReply("❌ Run /verify first.");
        
        const serverBinds = data.binds[guildId] || [];
        if (!serverBinds.length) return interaction.editReply("❌ No roles bound.");
        
        try {
            let added = [];
            const gRes = await axios.get(`https://groups.roproxy.com/v2/users/${robloxId}/groups/roles`);
            
            for (const b of serverBinds) {
                const match = gRes.data.data.find(g => g.group.id.toString() === b.groupId);
                const rank = match ? match.role.rank : 0;
                const role = interaction.guild.roles.cache.get(b.roleId);
                
                if (role) {
                    if (rank === b.rankId && !member.roles.cache.has(role.id)) { 
                        await member.roles.add(role); 
                        added.push(role.name); 
                    } else if (rank !== b.rankId && member.roles.cache.has(role.id)) { 
                        await member.roles.remove(role); 
                    }
                }
            }
            return interaction.editReply(`🔄 Sync complete. Added: ${added.join(', ') || 'None'}`);
        } catch (e) { return interaction.editReply("❌ Update network error."); }
    }
});

client.login(process.env.BOT_TOKEN);
