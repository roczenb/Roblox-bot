const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages] });

const DB_FILE = '/app/data/bot_data.json';
let data = { users: {}, groups: {}, binds: {} };

function loadData() {
    try {
        const dir = path.dirname(DB_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (fs.existsSync(DB_FILE)) data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) { console.log("Local Volume DB initialization setup."); }
}

function saveData() {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); } catch (e) { console.error(e); }
}

loadData();

const commands = [
    new SlashCommandBuilder().setName('verify').setDescription('Link your Roblox account globally').addStringOption(o => o.setName('username').setDescription('Username').setRequired(true)),
    new SlashCommandBuilder().setName('setup-group').setDescription('Link a Roblox Group ID to this server').addStringOption(o => o.setName('groupid').setDescription('Group ID').setRequired(true)),
    new SlashCommandBuilder().setName('sync-group-roles').setDescription('Auto create and bind all group roles safely without duplicates'),
    new SlashCommandBuilder().setName('bind').setDescription('Bind a specific rank to a role').addIntegerOption(o => o.setName('rankid').setDescription('Rank').setRequired(true)).addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)),
    new SlashCommandBuilder().setName('update').setDescription('Sync ranks in this server').addUserOption(o => o.setName('user').setDescription('Admin Only: Target user to update').setRequired(false))
].map(c => c.toJSON());

client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    try {
        await new REST({ version: '10' }).setToken(process.env.BOT_TOKEN).put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('Commands deployed!');
    } catch (e) { console.error(e); }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, options, guildId, member } = interaction;

    if (commandName === 'verify') {
        await interaction.deferReply();
        try {
            const res = await axios.post('https://users.roproxy.com/v1/usernames/users', { usernames: [options.getString('username')], excludeBannedUsers: true });
            if (!res.data.data.length) return interaction.editReply("❌ User not found.");
            const rId = res.data.data[0].id;
            data.users[interaction.user.id] = rId;
            saveData();
            return interaction.editReply(`✅ Verified globally as Roblox ID: ${rId}`);
        } catch (e) { return interaction.editReply(`❌ Error: ${e.message}`); }
    }

    if (commandName === 'setup-group') {
        if (!member.permissions.has('Administrator')) return interaction.reply("❌ Admins only.");
        await interaction.deferReply();
        if (!data.groups) data.groups = {};
        data.groups[guildId] = options.getString('groupid');
        saveData();
        return interaction.editReply("✅ Group linked successfully to this server.");
    }

    // --- FIX: NO DUPLICATE ROLES SYNC ---
    if (commandName === 'sync-group-roles') {
        if (!member.permissions.has('Administrator')) return interaction.reply("❌ Admins only.");
        await interaction.deferReply();
        
        const gId = data.groups ? data.groups[guildId] : null;
        if (!gId) return interaction.editReply("❌ Run /setup-group first.");
        
        try {
            const rRoles = (await axios.get(`https://groups.roproxy.com/v1/groups/${gId}/roles`)).data.roles.filter(r => r.rank > 0);
            let createdCount = 0;
            let boundCount = 0;
            
            if (!data.binds) data.binds = {};
            if (!data.binds[guildId]) data.binds[guildId] = [];

            for (const r of rRoles) {
                // Remove old binds for this rank to avoid stacking duplicates in the JSON data file
                data.binds[guildId] = data.binds[guildId].filter(b => !(b.groupId === gId && b.rankId === r.rank));

                // Look for an existing role with this exact name in the server
                let existingRole = interaction.guild.roles.cache.find(role => role.name === r.name);
                
                if (!existingRole) {
                    // Create it if it truly doesn't exist
                    existingRole = await interaction.guild.roles.create({ name: r.name, reason: 'Auto-sync' });
                    createdCount++;
                }
                
                // Map the rank to the existing or newly made role ID
                data.binds[guildId].push({ groupId: gId, rankId: r.rank, roleId: existingRole.id });
                boundCount++;
            }
            saveData();
            return interaction.editReply(`🎉 **Sync complete!** Processed **${boundCount}** ranks. (Created ${createdCount} brand new roles, linked the rest to matching existing roles).`);
        } catch (e) { return interaction.editReply(`❌ Sync fail: ${e.message}`); }
    }

    if (commandName === 'bind') {
        if (!member.permissions.has('Administrator')) return interaction.reply("❌ Admins only.");
        await interaction.deferReply();
        const gId = data.groups ? data.groups[guildId] : null;
        if (!gId) return interaction.editReply("❌ Run /setup-group first.");
        if (!data.binds) data.binds = {};
        if (!data.binds[guildId]) data.binds[guildId] = [];
        
        // Wipe old binds for this rank first to prevent duplicates
        data.binds[guildId] = data.binds[guildId].filter(b => !(b.groupId === gId && b.rankId === options.getInteger('rankid')));
        
        data.binds[guildId].push({ groupId: gId, rankId: options.getInteger('rankid'), roleId: options.getRole('role').id });
        saveData();
        return interaction.editReply("✅ Rank bound for this server.");
    }

    // --- FIX: UPDATE TARGET USERS ---
    if (commandName === 'update') {
        await interaction.deferReply();
        
        // Find out who we are updating: the target option or the user who ran the command
        const targetUser = options.getUser('user') || interaction.user;
        const isTargetingOther = targetUser.id !== interaction.user.id;

        // Protection: Only admins can specify a different target user
        if (isTargetingOther && !member.permissions.has('Administrator')) {
            return interaction.editReply("❌ You must be a server Administrator to update other members.");
        }

        const robloxId = data.users[targetUser.id];
        if (!robloxId) {
            return interaction.editReply(isTargetingOther ? `❌ That user has not run \`/verify\` yet.` : "❌ Run \`/verify\` first before running update.");
        }
        
        const serverBinds = data.binds ? data.binds[guildId] : [];
        if (!serverBinds || !serverBinds.length) return interaction.editReply("❌ No roles are bound on this server yet.");
        
        try {
            let added = [];
            const targetMember = await interaction.guild.members.fetch(targetUser.id);
            const gRes = await axios.get(`https://groups.roproxy.com/v2/users/${robloxId}/groups/roles`);
            
            for (const b of serverBinds) {
                const match = gRes.data.data.find(g => g.group.id.toString() === b.groupId);
                const rank = match ? match.role.rank : 0;
                const role = interaction.guild.roles.cache.get(b.roleId);
                
                if (role) {
                    if (rank === b.rankId && !targetMember.roles.cache.has(role.id)) { 
                        await targetMember.roles.add(role); 
                        added.push(role.name); 
                    } else if (rank !== b.rankId && targetMember.roles.cache.has(role.id)) { 
                        await targetMember.roles.remove(role); 
                    }
                }
            }

            const embed = new EmbedBuilder()
                .setTitle("Update Complete")
                .setColor(0x2ECC71) 
                .setThumbnail(targetUser.displayAvatarURL({ dynamic: true })) 
                .addFields(
                    { name: "User:", value: `<@${targetUser.id}>`, inline: false },
                    { name: "Roles Added", value: added.length > 0 ? added.join('\n') : "No new ranks to add.", inline: false }
                );

            return interaction.editReply({ embeds: [embed] });
        } catch (e) { return interaction.editReply("❌ Update network error."); }
    }
});

client.login(process.env.BOT_TOKEN);
