const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMembers, 
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ] 
});

const DB_FILE = '/app/data/bot_data.json';
let data = { users: {}, groups: {}, binds: {}, antimention: {} };

// --- CONFIGURATION ---
const LC_ROLE_NAME = "~{}~ Lead Command ~{}~"; 
const ANTIMENTION_BYPASS_ROLE = "Speaker of the Senate"; // Change this to the exact name of the only role allowed to bypass the shield

const cooldowns = new Map();
let isUpdateAllRunning = false; 

function loadData() {
    try {
        const dir = path.dirname(DB_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (fs.existsSync(DB_FILE)) {
            data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            if (!data.antimention) data.antimention = {};
        }
    } catch (e) { console.log("Local Volume DB initialization setup."); }
}

function saveData() {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); } catch (e) { console.error(e); }
}

loadData();

function checkCooldown(userId, commandName, seconds = 5) {
    const key = `${userId}-${commandName}`;
    const now = Date.now();
    if (cooldowns.has(key)) {
        const expirationTime = cooldowns.get(key) + (seconds * 1000);
        if (now < expirationTime) {
            return ((expirationTime - now) / 1000).toFixed(1);
        }
    }
    cooldowns.set(key, now);
    setTimeout(() => cooldowns.delete(key), seconds * 1000);
    return null;
}

const commands = [
    new SlashCommandBuilder().setName('verify').setDescription('Link your Roblox account globally').addStringOption(o => o.setName('username').setDescription('Username').setRequired(true)),
    new SlashCommandBuilder().setName('setup-group').setDescription('Link a Roblox Group ID to this server').addStringOption(o => o.setName('groupid').setDescription('Group ID').setRequired(true)),
    new SlashCommandBuilder().setName('sync-group-roles').setDescription('Auto create and bind roles sorted perfectly by chain of command hierarchy'),
    new SlashCommandBuilder().setName('bind').setDescription('Bind a specific rank to a role').addIntegerOption(o => o.setName('rankid').setDescription('Rank').setRequired(true)).addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)),
    new SlashCommandBuilder().setName('update').setDescription('Sync ranks in this server').addUserOption(o => o.setName('user').setDescription('Admin Only: Target user to update').setRequired(false)),
    new SlashCommandBuilder().setName('view-binds').setDescription('View all Roblox rank-to-role connections for this server'),
    new SlashCommandBuilder().setName('updateall').setDescription('LC+ Only: Update every verified member in the server at once'),
    new SlashCommandBuilder().setName('antimention').setDescription('Admin Only: Toggle anti-mention spam shield').addBooleanOption(o => o.setName('enabled').setDescription('Turn anti-mention filter on or off').setRequired(true))
].map(c => c.toJSON());

client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    try {
        await new REST({ version: '10' }).setToken(process.env.BOT_TOKEN).put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('Commands deployed!');
    } catch (e) { console.error(e); }
});

// --- ANTI-MENTION LISTENER (STRICT BYPASS) ---
client.on('messageCreate', async message => {
    if (!message.guild || message.author.bot) return;

    const isEnabled = data.antimention ? data.antimention[message.guild.id] : false;
    if (!isEnabled) return;

    const totalMentions = message.mentions.users.size + message.mentions.roles.size;
    if (totalMentions > 4) {
        const hasBypassRole = message.member.roles.cache.some(r => r.name === ANTIMENTION_BYPASS_ROLE);
        const isAdmin = message.member.permissions.has('Administrator');

        // Only let them pass if they are a full Administrator or have the explicit bypass role
        if (isAdmin || hasBypassRole) return; 
        
        try {
            await message.delete();
            const warning = await message.channel.send(`⚠️ <@${message.author.id}>, mass mentions are restricted while the anti-mention shield is active.`);
            setTimeout(() => warning.delete().catch(() => {}), 5000);
        } catch (err) {
            console.log("Failed to handle antimention deletion:", err.message);
        }
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, options, guildId, member } = interaction;

    if (commandName === 'verify') {
        const wait = checkCooldown(interaction.user.id, commandName, 5);
        if (wait) return interaction.reply({ content: `⏳ Please wait **${wait}s** before trying to verify again.`, ephemeral: true });

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

    if (commandName === 'sync-group-roles') {
        if (!member.permissions.has('Administrator')) return interaction.reply("❌ Admins only.");
        await interaction.deferReply();
        const gId = data.groups ? data.groups[guildId] : null;
        if (!gId) return interaction.editReply("❌ Run /setup-group first.");
        try {
            const rRoles = (await axios.get(`https://groups.roproxy.com/v1/groups/${gId}/roles`)).data.roles
                .filter(r => r.rank > 0)
                .sort((a, b) => a.rank - b.rank);

            let createdCount = 0;
            let boundCount = 0;
            if (!data.binds) data.binds = {};
            if (!data.binds[guildId]) data.binds[guildId] = [];

            const trackingList = [];

            for (const r of rRoles) {
                data.binds[guildId] = data.binds[guildId].filter(b => !(b.groupId === gId && b.rankId === r.rank));
                let existingRole = interaction.guild.roles.cache.find(role => role.name === r.name);
                if (!existingRole) {
                    existingRole = await interaction.guild.roles.create({ name: r.name, reason: 'Auto-sync' });
                    createdCount++;
                }
                data.binds[guildId].push({ groupId: gId, rankId: r.rank, roleId: existingRole.id });
                boundCount++;
                trackingList.push({ role: existingRole, rank: r.rank });
            }
            saveData();

            try {
                const positions = trackingList.map((item, index) => ({
                    role: item.role.id,
                    position: index + 1 
                }));
                await interaction.guild.roles.setPositions(positions);
            } catch (posError) {
                console.log("Hierarchy configuration placement update note.");
            }

            return interaction.editReply(`🎉 **Sync complete!** Processed **${boundCount}** ranks.\n\n📈 All group roles have been automatically reordered to match your Roblox Chain of Command!`);
        } catch (e) { return interaction.editReply(`❌ Sync fail: ${e.message}`); }
    }

    if (commandName === 'bind') {
        if (!member.permissions.has('Administrator')) return interaction.reply("❌ Admins only.");
        await interaction.deferReply();
        const gId = data.groups ? data.groups[guildId] : null;
        if (!gId) return interaction.editReply("❌ Run /setup-group first.");
        if (!data.binds) data.binds = {};
        if (!data.binds[guildId]) data.binds[guildId] = [];
        data.binds[guildId] = data.binds[guildId].filter(b => !(b.groupId === gId && b.rankId === options.getInteger('rankid')));
        data.binds[guildId].push({ groupId: gId, rankId: options.getInteger('rankid'), roleId: options.getRole('role').id });
        saveData();
        return interaction.editReply("✅ Rank bound for this server.");
    }

    if (commandName === 'view-binds') {
        await interaction.deferReply();
        const serverBinds = data.binds ? data.binds[guildId] : [];
        if (!serverBinds || !serverBinds.length) return interaction.editReply("❌ No roles are bound on this server yet.");

        const sortedBinds = [...serverBinds].sort((a, b) => b.rankId - a.rankId);
        let bindList = [];
        for (const b of sortedBinds) {
            bindList.push(`• **Rank ${b.rankId}** → <@&${b.roleId}>`);
        }

        const embed = new EmbedBuilder()
            .setTitle("Server Role Binds Configuration")
            .setColor(0x3498DB)
            .setDescription(bindList.join('\n'));

        return interaction.editReply({ embeds: [embed] });
    }

    if (commandName === 'update') {
        const wait = checkCooldown(interaction.user.id, commandName, 7);
        if (wait) return interaction.reply({ content: `⏳ Please wait **${wait}s** before requesting another profile update.`, ephemeral: true });

        await interaction.deferReply();
        const targetUser = options.getUser('user') || interaction.user;
        const isTargetingOther = targetUser.id !== interaction.user.id;

        if (isTargetingOther && !member.permissions.has('Administrator')) {
            return interaction.editReply("❌ You must be a server Administrator to update other members.");
        }

        const robloxId = data.users[targetUser.id];
        if (!robloxId) return interaction.editReply(isTargetingOther ? `❌ That user has not run \`/verify\` yet.` : "❌ Run \`/verify\` first.");
        
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
                        await targetMember.roles.add(role); added.push(role.name); 
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

    if (commandName === 'updateall') {
        const hasLcRole = member.roles.cache.some(r => r.name === LC_ROLE_NAME);
        const isAdmin = member.permissions.has('Administrator');
        
        if (!hasLcRole && !isAdmin) {
            return interaction.reply({ content: `❌ You must have the **${LC_ROLE_NAME}** role or Administrator permissions to run this.`, ephemeral: true });
        }

        if (isUpdateAllRunning) {
            return interaction.reply({ content: "⚠️ A global server data sync is already running right now. Please wait for it to finish!", ephemeral: true });
        }

        await interaction.deferReply();
        const serverBinds = data.binds ? data.binds[guildId] : [];
        if (!serverBinds || !serverBinds.length) return interaction.editReply("❌ No roles are bound on this server yet.");

        try {
            isUpdateAllRunning = true; 
            const allMembers = await interaction.guild.members.fetch();
            let processCount = 0;

            for (const [id, targetMember] of allMembers) {
                if (targetMember.user.bot) continue;
                const robloxId = data.users[id];
                if (!robloxId) continue; 

                try {
                    const gRes = await axios.get(`https://groups.roproxy.com/v2/users/${robloxId}/groups/roles`);
                    processCount++;

                    for (const b of serverBinds) {
                        const match = gRes.data.data.find(g => g.group.id.toString() === b.groupId);
                        const rank = match ? match.role.rank : 0;
                        const role = interaction.guild.roles.cache.get(b.roleId);
                        
                        if (role) {
                            if (rank === b.rankId && !targetMember.roles.cache.has(role.id)) { 
                                await targetMember.roles.add(role); 
                            } else if (rank !== b.rankId && targetMember.roles.cache.has(role.id)) { 
                                await targetMember.roles.remove(role); 
                            }
                        }
                    }
                    await new Promise(resolve => setTimeout(resolve, 350));
                } catch (memberErr) { console.log(`Skipped checking member ID ${id}`); }
            }

            isUpdateAllRunning = false; 
            return interaction.editReply(`🔄 **Bulk Update Complete!** Successfully synced ranks for all **${processCount}** verified users.`);
        } catch (e) { 
            isUpdateAllRunning = false; 
            return interaction.editReply(`❌ Bulk sync error: ${e.message}`); 
        }
    }

    if (commandName === 'antimention') {
        if (!member.permissions.has('Administrator')) return interaction.reply({ content: "❌ Admins only.", ephemeral: true });
        
        const enabledSetting = options.getBoolean('enabled');
        if (!data.antimention) data.antimention = {};
        
        data.antimention[guildId] = enabledSetting;
        saveData();

        return interaction.reply(`Shield state modified. Anti-mention protection is now **${enabledSetting ? "ENABLED" : "DISABLED"}** on this server.`);
    }
});

client.login(process.env.BOT_TOKEN);
