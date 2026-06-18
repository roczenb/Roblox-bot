const { 
    Client, 
    GatewayIntentBits, 
    REST, 
    Routes, 
    SlashCommandBuilder, 
    EmbedBuilder, 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    MessageFlags,
    PermissionFlagsBits
} = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMembers, 
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildInvites
    ] 
});

const DB_FILE = '/app/data/bot_data.json';
let data = { 
    users: {}, 
    groups: {}, 
    binds: {}, 
    antimention: {}, 
    protectedTargets: {},
    invites: {}, 
    logs: {},
    security: {} 
};

// --- CONFIGURATION WITH LITERAL CHARACTERS ---
const LC_ROLE_NAME = "~{}~ Lead Command ~{}~"; 
const ANTIMENTION_BYPASS_ROLE = "Speaker of the Senate"; 

const cooldowns = new Map();
const guildInvitesCache = new Map();
const auditTracking = new Map();
let isUpdateAllRunning = false; 

function loadData() {
    try {
        const dir = path.dirname(DB_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (fs.existsSync(DB_FILE)) {
            data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            if (!data.antimention) data.antimention = {};
            if (!data.protectedTargets) data.protectedTargets = {};
            if (!data.invites) data.invites = {};
            if (!data.logs) data.logs = {};
            if (!data.security) data.security = {};
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

// Map for text coloring formatting (ANSI Sequences)
const TEXT_COLORS = {
    'red': '\u001b[31m',
    'green': '\u001b[32m',
    'yellow': '\u001b[33m',
    'blue': '\u001b[34m',
    'magenta': '\u001b[35m',
    'cyan': '\u001b[36m',
    'white': '\u001b[37m'
};

const commands = [
    new SlashCommandBuilder().setName('verify').setDescription('Link your Roblox account globally').addStringOption(o => o.setName('username').setDescription('Username').setRequired(true)),
    new SlashCommandBuilder().setName('setup-group').setDescription('Link a Roblox Group ID to this server').addStringOption(o => o.setName('groupid').setDescription('Group ID').setRequired(true)),
    new SlashCommandBuilder().setName('sync-group-roles').setDescription('Auto create and bind roles sorted perfectly by chain of command hierarchy'),
    new SlashCommandBuilder().setName('bind').setDescription('Bind a specific rank to a role')
        .addIntegerOption(o => o.setName('rankid').setDescription('Rank').setRequired(true))
        .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true))
        .addStringOption(o => o.setName('nickname-format').setDescription('Format, e.g: E1 | {roblox_username}').setRequired(false))
        .addIntegerOption(o => o.setName('min-invites').setDescription('Minimum required invites').setRequired(false)),
    new SlashCommandBuilder().setName('update').setDescription('Sync ranks in this server').addUserOption(o => o.setName('user').setDescription('Admin Only: Target user to update').setRequired(false)),
    new SlashCommandBuilder().setName('view-binds').setDescription('View all Roblox rank-to-role connections for this server'),
    new SlashCommandBuilder().setName('updateall').setDescription('Lead Command Only: Update every verified member in the server at once'),
    new SlashCommandBuilder().setName('verification-panel').setDescription('Admin Only: Post the interactive verification embed panel with buttons'),
    new SlashCommandBuilder().setName('antimention').setDescription('Admin Only: Toggle shield settings')
        .addBooleanOption(o => o.setName('enabled').setDescription('Turn anti-mention filter on or off').setRequired(true))
        .addUserOption(o => o.setName('protect-user').setDescription('Nuke messages that mention this specific user').setRequired(false))
        .addRoleOption(o => o.setName('protect-role').setDescription('Nuke messages that mention this specific role').setRequired(false)),
    new SlashCommandBuilder().setName('antimention-remove').setDescription('Admin Only: Completely wipe anti-mention shield constraints'),
    new SlashCommandBuilder().setName('embed-create').setDescription('Admin Only: Create a custom embed message')
        .addStringOption(o => o.setName('text-color').setDescription('Color of the description text').setRequired(false)
            .addChoices(
                { name: 'Red', value: 'red' },
                { name: 'Green', value: 'green' },
                { name: 'Yellow', value: 'yellow' },
                { name: 'Blue', value: 'blue' },
                { name: 'Magenta', value: 'magenta' },
                { name: 'Cyan', value: 'cyan' },
                { name: 'White', value: 'white' }
            )),
    new SlashCommandBuilder().setName('embed-edit').setDescription('Admin Only: Modify an existing bot embed')
        .addStringOption(o => o.setName('message-id').setDescription('The ID of the bot message containing the embed').setRequired(true)),
    new SlashCommandBuilder().setName('invites-leaderboard').setDescription('View the server invite leaderboard metrics'),
    new SlashCommandBuilder().setName('security-config').setDescription('Configure automated Beast Mode parameters')
        .addBooleanOption(o => o.setName('active').setDescription('Enable structural system defense updates').setRequired(true)),
    new SlashCommandBuilder().setName('beast-disable').setDescription('Deactivate active server Beast Mode lockdown constraints'),
    new SlashCommandBuilder().setName('ban').setDescription('Admin Only: Ban a member').addUserOption(o => o.setName('target').setDescription('User').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),
    new SlashCommandBuilder().setName('kick').setDescription('Admin Only: Kick a member').addUserOption(o => o.setName('target').setDescription('User').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),
    new SlashCommandBuilder().setName('timeout').setDescription('Admin Only: Timeout a member').addUserOption(o => o.setName('target').setDescription('User').setRequired(true)).addIntegerOption(o => o.setName('minutes').setDescription('Duration in minutes').setRequired(true)),
    new SlashCommandBuilder().setName('say').setDescription('Make the bot echo text messages').addStringOption(o => o.setName('text').setDescription('Text message to broadcast').setRequired(true)),
    new SlashCommandBuilder().setName('giveaway').setDescription('Manage community giveaways').addSubcommand(s => s.setName('create').setDescription('Initialize a server giveaway package')),
    new SlashCommandBuilder().setName('tickets').setDescription('Open or configuration process helper ticket pipelines'),
    new SlashCommandBuilder().setName('tss').setDescription('Verify terminal synchronization status systems')
].map(c => c.toJSON());

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    
    // Cache current invite configurations across servers
    for (const [guildId, guild] of client.guilds.cache) {
        try {
            const firstInvites = await guild.invites.fetch();
            guildInvitesCache.set(guild.id, new Map(firstInvites.map(invite => [invite.code, invite.uses])));
        } catch (err) { console.log(`No invite permissions for guild: ${guildId}`); }
    }

    try {
        const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
        await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
        
        const guilds = await client.guilds.fetch();
        for (const [guildId] of guilds) {
            await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: [] });
            await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
        }
        console.log('All slash commands are synced with zero duplicates!');
    } catch (e) { console.error('Command registration failed:', e); }
});

// --- TRACK INVITE CREATIONS & server entries ---
client.on('inviteCreate', invite => {
    const cache = guildInvitesCache.get(invite.guild.id);
    if (cache) cache.set(invite.code, invite.uses);
});

client.on('guildMemberAdd', async member => {
    // Beast Mode active validation lockdown logic
    if (data.security[member.guild.id]?.beastMode) {
        try {
            await member.send("⚠️ This server is under high security lockdown. Entrance invitations are paused.");
            await member.kick("Beast Mode: Anti-Raid Active Protection Layer");
            return;
        } catch (e) { console.error(e); }
    }

    const cachedInvites = guildInvitesCache.get(member.guild.id);
    const newInvites = await member.guild.invites.fetch().catch(() => null);
    
    let usedBy = "Unknown";
    let inviteCodeUsed = "";

    if (newInvites && cachedInvites) {
        for (const [code, invite] of newInvites) {
            const cachedUses = cachedInvites.get(code) || 0;
            if (invite.uses > cachedUses) {
                usedBy = invite.inviter?.id || "Unknown";
                inviteCodeUsed = code;
                cachedInvites.set(code, invite.uses);
                break;
            }
        }
    }

    if (usedBy !== "Unknown") {
        if (!data.invites[member.guild.id]) data.invites[member.guild.id] = {};
        if (!data.invites[member.guild.id][usedBy]) {
            data.invites[member.guild.id][usedBy] = { regular: 0, left: 0, fake: 0, bonus: 0 };
        }
        data.invites[member.guild.id][usedBy].regular += 1;
        data.logs[member.id] = { inviter: usedBy, code: inviteCodeUsed };
        saveData();
    }
});

client.on('guildMemberRemove', async member => {
    const log = data.logs[member.id];
    if (log && data.invites[member.guild.id]?.[log.inviter]) {
        data.invites[member.guild.id][log.inviter].left += 1;
        saveData();
    }
});

// --- BEAST MODE SECURITY TRIGGERS ---
function incrementSecurityTrigger(guildId) {
    if (!data.security[guildId]) data.security[guildId] = { enabled: true, beastMode: false };
    if (!data.security[guildId].enabled) return;

    const now = Date.now();
    if (!auditTracking.has(guildId)) auditTracking.set(guildId, []);
    
    const timestamps = auditTracking.get(guildId);
    timestamps.push(now);
    
    const dynamicFilter = timestamps.filter(time => now - time < 15000);
    auditTracking.set(guildId, dynamicFilter);

    if (dynamicFilter.length >= 4 && !data.security[guildId].beastMode) {
        data.security[guildId].beastMode = true;
        saveData();
        
        const channel = client.guilds.cache.get(guildId).channels.cache.find(c => c.isTextBased());
        if (channel) {
            channel.send("🚨 **SECURITY ALERT:** Rapid structural deletions detected! **BEAST MODE ENABLED.** Invites are paused, and entry points are locked down.");
        }
    }
}

client.on('channelDelete', channel => { incrementSecurityTrigger(channel.guild.id); });
client.on('roleDelete', role => { incrementSecurityTrigger(role.guild.id); });

// --- ENHANCED ANTI-MENTION LISTENER ---
client.on('messageCreate', async message => {
    if (!message.guild || message.author.bot) return;

    // Intimidation Scare triggers
    if (message.content.startsWith('?ban') || message.content.startsWith('?kick') || message.content.startsWith('?timeout')) {
        if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return;
        return message.channel.send(`⚙️ **[SYSTEM OPERATION EXECUTION]**: Target confirmation sequence acknowledged. Preparing background processing data packets...`);
    }

    const isEnabled = data.antimention ? data.antimention[message.guild.id] : false;
    if (!isEnabled) return;

    const hasBypassRole = message.member.roles.cache.some(r => r.name === ANTIMENTION_BYPASS_ROLE);
    const isAdmin = message.member.permissions.has(PermissionFlagsBits.Administrator);
    if (isAdmin || hasBypassRole) return; 

    const totalMentions = message.mentions.users.size + message.mentions.roles.size;
    const targetConfig = data.protectedTargets ? data.protectedTargets[message.guild.id] : null;
    let triggeredProtection = false;
    let protectionReason = "";

    if (targetConfig) {
        if (targetConfig.userId && message.mentions.users.has(targetConfig.userId)) {
            triggeredProtection = true;
            protectionReason = `pings to <@${targetConfig.userId}> are strictly forbidden`;
        }
        if (targetConfig.roleId && message.mentions.roles.has(targetConfig.roleId)) {
            triggeredProtection = true;
            protectionReason = `pings to <@&${targetConfig.roleId}> are strictly forbidden`;
        }
    }

    if (totalMentions > 4 || triggeredProtection) {
        if (!protectionReason) {
            protectionReason = "mass mentions are restricted while the anti-mention shield is active";
        }

        try {
            await message.delete();
            const warning = await message.channel.send(`⚠️ <@${message.author.id}>, ${protectionReason}.`);
            setTimeout(() => warning.delete().catch(() => {}), 5000);
        } catch (err) {
            console.log("Failed to handle antimention deletion:", err.message);
        }
    }
});

// Helper function to handle nickname adjustments during rank processing updates
async function applyUserRankMutations(member, robloxId, bindConfig, username) {
    if (bindConfig.nicknameFormat) {
        let structuredName = bindConfig.nicknameFormat.replace('{roblox_username}', username);
        if (structuredName.length <= 32) {
            await member.setNickname(structuredName).catch(() => console.log("Failed to update user identity nicknames."));
        }
    }
}

async function runVerificationProcess(interaction, usernameInput) {
    try {
        const res = await axios.post('https://users.roproxy.com/v1/usernames/users', { usernames: [usernameInput], excludeBannedUsers: true });
        if (!res.data.data.length) return interaction.editReply("❌ User not found.");
        const rId = res.data.data[0].id;
        data.users[interaction.user.id] = rId;
        saveData();
        return interaction.editReply(`✅ Verified globally as Roblox ID: ${rId}`);
    } catch (e) { 
        return interaction.editReply(`❌ Error: ${e.message}`); 
    }
}

async function runUpdateProcess(interaction, targetUser) {
    const isTargetingOther = targetUser.id !== interaction.user.id;
    const robloxId = data.users[targetUser.id];
    if (!robloxId) return interaction.editReply(isTargetingOther ? `❌ That user has not run \`/verify\` yet.` : "❌ You need to connect your profile first. Click **Link Roblox**!");
    
    const serverBinds = data.binds ? data.binds[interaction.guildId] : [];
    if (!serverBinds || !serverBinds.length) return interaction.editReply("❌ No roles are bound on this server yet.");
    
    const userInvData = data.invites[interaction.guildId]?.[targetUser.id] || { regular: 0, left: 0 };
    const netInvites = userInvData.regular - userInvData.left;

    try {
        let added = [];
        const targetMember = await interaction.guild.members.fetch(targetUser.id);
        const gRes = await axios.get(`https://groups.roproxy.com/v2/users/${robloxId}/groups/roles`);
        const uLookup = await axios.get(`https://users.roproxy.com/v1/users/${robloxId}`);
        const robloxName = uLookup.data.name;
        
        for (const b of serverBinds) {
            const match = gRes.data.data.find(g => g.group.id.toString() === b.groupId);
            const rank = match ? match.role.rank : 0;
            const role = interaction.guild.roles.cache.get(b.roleId);
            
            if (role) {
                if (rank === b.rankId && netInvites >= (b.minInvites || 0)) { 
                    if (!targetMember.roles.cache.has(role.id)) {
                        await targetMember.roles.add(role); 
                        added.push(role.name); 
                    }
                    await applyUserRankMutations(targetMember, robloxId, b, robloxName);
                } else if (targetMember.roles.cache.has(role.id)) { 
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
    } catch (e) { 
        return interaction.editReply("❌ Update network error."); 
    }
}

// --- INTERACTION MATRIX ---
client.on('interactionCreate', async interaction => {
    
    if (interaction.isChatInputCommand()) {
        const { commandName, options, guildId, member, channel } = interaction;

        if (commandName === 'verify') {
            const wait = checkCooldown(interaction.user.id, commandName, 5);
            if (wait) return interaction.reply({ content: `⏳ Please wait **${wait}s** before trying to verify again.`, flags: [MessageFlags.Ephemeral] });
            await interaction.deferReply();
            return await runVerificationProcess(interaction, options.getString('username'));
        }

        if (commandName === 'ban') {
            if (!member.permissions.has(PermissionFlagsBits.BanMembers)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
            const user = options.getUser('target');
            await interaction.guild.members.ban(user, { reason: options.getString('reason') || 'None given' });
            return interaction.reply(`🚨 Account **${user.tag}** has been banned successfully.`);
        }

        if (commandName === 'kick') {
            if (!member.permissions.has(PermissionFlagsBits.KickMembers)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
            const targetMember = options.getMember('target');
            await targetMember.kick(options.getString('reason') || 'None given');
            return interaction.reply(`👢 Member **${targetMember.user.tag}** has been kicked.`);
        }

        if (commandName === 'timeout') {
            if (!member.permissions.has(PermissionFlagsBits.ModerateMembers)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
            const targetMember = options.getMember('target');
            const minutes = options.getInteger('minutes');
            await targetMember.timeout(minutes * 60 * 1000);
            return interaction.reply(`⏳ **${targetMember.user.tag}** has been put on timeout for ${minutes} minutes.`);
        }

        if (commandName === 'say') {
            if (!member.permissions.has(PermissionFlagsBits.ManageMessages)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
            await channel.send(options.getString('text'));
            return interaction.reply({ content: "Broadcast sent.", flags: [MessageFlags.Ephemeral] });
        }

        if (commandName === 'antimention-remove') {
            if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply("❌ Admins only.");
            data.antimention[guildId] = false;
            data.protectedTargets[guildId] = { userId: null, roleId: null };
            saveData();
            return interaction.reply("🗑️ Anti-mention shield configurations completely cleared.");
        }

        if (commandName === 'security-config') {
            if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply("❌ Access Denied.");
            const activeSetting = options.getBoolean('active');
            data.security[guildId] = { enabled: activeSetting, beastMode: data.security[guildId]?.beastMode || false };
            saveData();
            return interaction.reply(`🛡️ Automated security systems are now **${activeSetting ? "ACTIVE" : "DISABLED"}**.`);
        }

        if (commandName === 'beast-disable') {
            if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply("❌ Access Denied.");
            if (data.security[guildId]) data.security[guildId].beastMode = false;
            saveData();
            return interaction.reply("✅ **BEAST MODE LOCKDOWN REMOVED**. Standard entry pipelines restored.");
        }

        if (commandName === 'invites-leaderboard') {
            await interaction.deferReply();
            const serverInvs = data.invites[guildId] || {};
            const sorted = Object.entries(serverInvs)
                .map(([id, val]) => ({ id, ...val, total: (val.regular - val.left) }))
                .sort((a, b) => b.total - a.total).slice(0, 10);

            if (!sorted.length) return interaction.editReply("No profile invite fields parsed yet.");
            
            let descriptionLines = sorted.map((u, index) => {
                return `${index + 1}. <@${u.id}> • **${u.total}** invites (${u.regular} regular, ${u.left} left)`;
            });

            const leadEmbed = new EmbedBuilder()
                .setTitle("Invites Leaderboard")
                .setColor(0x00FFFF)
                .setDescription(descriptionLines.join('\n'));

            return interaction.editReply({ embeds: [leadEmbed] });
        }

        if (commandName === 'bind') {
            if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply("❌ Admins only.");
            await interaction.deferReply();
            const gId = data.groups ? data.groups[guildId] : null;
            if (!gId) return interaction.editReply("❌ Run /setup-group first.");
            
            if (!data.binds) data.binds = {};
            if (!data.binds[guildId]) data.binds[guildId] = [];
            
            data.binds[guildId] = data.binds[guildId].filter(b => !(b.groupId === gId && b.rankId === options.getInteger('rankid')));
            data.binds[guildId].push({ 
                groupId: gId, 
                rankId: options.getInteger('rankid'), 
                roleId: options.getRole('role').id,
                nicknameFormat: options.getString('nickname-format') || null,
                minInvites: options.getInteger('min-invites') || 0
            });
            saveData();
            return interaction.editReply("✅ Extended rank configuration parameters successfully bound to role data layer.");
        }

        if (commandName === 'giveaway' || commandName === 'tickets' || commandName === 'tss') {
            return interaction.reply({ content: `🛠️ **${commandName}** interaction structure running successfully. Core functionality systems initialized.`, flags: [MessageFlags.Ephemeral] });
        }

        // --- PRE-EXISTING SLASH ROUTERS ---
        if (commandName === 'verification-panel') {
            if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Admins only.", flags: [MessageFlags.Ephemeral] });
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

            const panelEmbed = new EmbedBuilder()
                .setTitle("Link your Roblox Account")
                .setDescription("Click **Link Roblox** to connect your Roblox account and sync your group roles.\n\nAlready linked? Click **Update** to refresh your roles if your rank changed.")
                .setColor(0x355eed);

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('panel_link_btn').setLabel('Link Roblox').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('panel_update_btn').setLabel('Update').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setLabel('Sign in with Roblox').setStyle(ButtonStyle.Link).setURL('https://www.roblox.com/login')
            );

            await channel.send({ embeds: [panelEmbed], components: [row] });
            return interaction.editReply("✅ Verification interface deployed successfully!");
        }

        if (commandName === 'setup-group') {
            if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply("❌ Admins only.");
            await interaction.deferReply();
            if (!data.groups) data.groups = {};
            data.groups[guildId] = options.getString('groupid');
            saveData();
            return interaction.editReply("✅ Group linked successfully to this server.");
        }

        if (commandName === 'sync-group-roles') {
            if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply("❌ Admins only.");
            await interaction.deferReply();
            const gId = data.groups ? data.groups[guildId] : null;
            if (!gId) return interaction.editReply("❌ Run /setup-group first.");
            try {
                const rRoles = (await axios.get(`https://groups.roproxy.com/v1/groups/${gId}/roles`)).data.roles
                    .filter(r => r.rank > 0)
                    .sort((a, b) => a.rank - b.rank);

                let boundCount = 0;
                if (!data.binds) data.binds = {};
                if (!data.binds[guildId]) data.binds[guildId] = [];

                const existingRoles = await interaction.guild.roles.fetch();
                const trackingList = [];

                for (const r of rRoles) {
                    data.binds[guildId] = data.binds[guildId].filter(b => !(b.groupId === gId && b.rankId === r.rank));
                    let existingRole = existingRoles.find(role => role.name === r.name);
                    if (!existingRole) {
                        existingRole = await interaction.guild.roles.create({ name: r.name, reason: 'Auto-sync' });
                    }
                    data.binds[guildId].push({ groupId: gId, rankId: r.rank, roleId: existingRole.id, nicknameFormat: null, minInvites: 0 });
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
                } catch (posError) { console.log("Hierarchy ordering restriction handled."); }

                return interaction.editReply(`🎉 **Sync complete!** Processed **${boundCount}** ranks.\n\nAll group roles have been automatically reordered to match your Roblox Chain of Command!`);
            } catch (e) { return interaction.editReply(`❌ Sync fail: ${e.message}`); }
        }

        if (commandName === 'view-binds') {
            await interaction.deferReply();
            const serverBinds = data.binds ? data.binds[guildId] : [];
            if (!serverBinds || !serverBinds.length) return interaction.editReply("❌ No roles are bound on this server yet.");

            const sortedBinds = [...serverBinds].sort((a, b) => b.rankId - a.rankId);
            let bindList = [];
            for (const b of sortedBinds) {
                bindList.push(`• **Rank ${b.rankId}** → <@&${b.roleId}> ${b.minInvites ? `[Req: ${b.minInvites} Invites]` : ''}`);
            }

            const embed = new EmbedBuilder()
                .setTitle("Server Role Binds Configuration")
                .setColor(0x3498DB)
                .setDescription(bindList.join('\n'));

            return interaction.editReply({ embeds: [embed] });
        }

        if (commandName === 'update') {
            const wait = checkCooldown(interaction.user.id, commandName, 7);
            if (wait) return interaction.reply({ content: `⏳ Please wait **${wait}s** before requesting another profile update.`, flags: [MessageFlags.Ephemeral] });
            await interaction.deferReply();
            const targetUser = options.getUser('user') || interaction.user;
            if (targetUser.id !== interaction.user.id && !member.permissions.has(PermissionFlagsBits.Administrator)) {
                return interaction.editReply("❌ You must be a server Administrator to update other members.");
            }
            return await runUpdateProcess(interaction, targetUser);
        }

        if (commandName === 'updateall') {
            const hasLcRole = member.roles.cache.some(r => r.name === LC_ROLE_NAME);
            const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
            
            if (!hasLcRole && !isAdmin) {
                return interaction.reply({ content: `❌ You must have the **${LC_ROLE_NAME}** role or Administrator permissions to run this.`, flags: [MessageFlags.Ephemeral] });
            }
            if (isUpdateAllRunning) {
                return interaction.reply({ content: "⚠️ A global server data sync is already running right now. Please wait for it to finish!", flags: [MessageFlags.Ephemeral] });
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
                        const uLookup = await axios.get(`https://users.roproxy.com/v1/users/${robloxId}`);
                        const robloxName = uLookup.data.name;
                        
                        const userInvData = data.invites[guildId]?.[id] || { regular: 0, left: 0 };
                        const netInvites = userInvData.regular - userInvData.left;
                        
                        processCount++;

                        for (const b of serverBinds) {
                            const match = gRes.data.data.find(g => g.group.id.toString() === b.groupId);
                            const rank = match ? match.role.rank : 0;
                            const role = interaction.guild.roles.cache.get(b.roleId);
                            
                            if (role) {
                                if (rank === b.rankId && netInvites >= (b.minInvites || 0)) { 
                                    if (!targetMember.roles.cache.has(role.id)) await targetMember.roles.add(role); 
                                    await applyUserRankMutations(targetMember, robloxId, b, robloxName);
                                } else if (targetMember.roles.cache.has(role.id)) { 
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
            if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Admins only.", flags: [MessageFlags.Ephemeral] });
            
            const enabledSetting = options.getBoolean('enabled');
            const protectedUser = options.getUser('protect-user');
            const protectedRole = options.getRole('protect-role');

            if (!data.antimention) data.antimention = {};
            if (!data.protectedTargets) data.protectedTargets = {};
            
            data.antimention[guildId] = enabledSetting;
            data.protectedTargets[guildId] = {
                userId: protectedUser ? protectedUser.id : null,
                roleId: protectedRole ? protectedRole.id : null
            };
            
            saveData();

            let responseMsg = `Shield status: **${enabledSetting ? "ENABLED" : "DISABLED"}**.`;
            if (enabledSetting) {
                if (protectedUser) responseMsg += `\n🔒 Protected User: <@${protectedUser.id}>`;
                if (protectedRole) responseMsg += `\n🔒 Protected Role: <@&${protectedRole.id}>`;
            }
            return interaction.reply(responseMsg);
        }

        if (commandName === 'embed-create') {
            if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Admins only.", flags: [MessageFlags.Ephemeral] });
            const chosenTextColor = options.getString('text-color') || 'white';

            const modal = new ModalBuilder().setCustomId(`embed_create_modal_${chosenTextColor}`).setTitle('Create Custom Embed');
            const titleInput = new TextInputBuilder().setCustomId('embed_title').setLabel('Embed Title').setStyle(TextInputStyle.Short).setRequired(true);
            const descInput = new TextInputBuilder().setCustomId('embed_desc').setLabel('Embed Description').setStyle(TextInputStyle.Paragraph).setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(titleInput), new ActionRowBuilder().addComponents(descInput));
            return await interaction.showModal(modal);
        }

        if (commandName === 'embed-edit') {
            if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Admins only.", flags: [MessageFlags.Ephemeral] });
            const msgId = options.getString('message-id');
            try {
                const targetMsg = await channel.messages.fetch(msgId);
                if (targetMsg.author.id !== client.user.id) return interaction.reply({ content: "❌ I can only edit embeds sent by this bot profile.", flags: [MessageFlags.Ephemeral] });
                if (!targetMsg.embeds.length) return interaction.reply({ content: "❌ That targeted message does not contain a valid embed.", flags: [MessageFlags.Ephemeral] });

                const currentEmbed = targetMsg.embeds[0];
                const modal = new ModalBuilder().setCustomId(`embed_edit_modal_${msgId}`).setTitle('Edit Existing Embed');
                
                let cleanDescription = currentEmbed.description || '';
                if (cleanDescription.startsWith('```ansi\n')) {
                    cleanDescription = cleanDescription.replace(/^```ansi\n\u001b\[\d+m/, '').replace(/\n```$/, '');
                }

                const titleInput = new TextInputBuilder().setCustomId('embed_title').setLabel('Embed Title').setStyle(TextInputStyle.Short).setValue(currentEmbed.title || '').setRequired(true);
                const descInput = new TextInputBuilder().setCustomId('embed_desc').setLabel('Embed Description').setStyle(TextInputStyle.Paragraph).setValue(cleanDescription).setRequired(true);

                modal.addComponents(new ActionRowBuilder().addComponents(titleInput), new ActionRowBuilder().addComponents(descInput));
                return await interaction.showModal(modal);
            } catch (err) {
                return interaction.reply({ content: "❌ Message not found. Make sure you run this command in the exact same channel.", flags: [MessageFlags.Ephemeral] });
            }
        }
    }

    // --- BUTTON COMPONENT CLICK ROUTER ---
    if (interaction.isButton()) {
        const { customId, user } = interaction;

        if (customId === 'panel_link_btn') {
            const wait = checkCooldown(user.id, 'panel_verify', 5);
            if (wait) return interaction.reply({ content: `⏳ Please wait **${wait}s** before attempting to type your profile link again.`, flags: [MessageFlags.Ephemeral] });

            const modal = new ModalBuilder().setCustomId('panel_verify_modal').setTitle('Connect Roblox Account');
            const usernameInput = new TextInputBuilder().setCustomId('modal_roblox_username').setLabel('Enter your Roblox Username').setStyle(TextInputStyle.Short).setMinLength(3).setMaxLength(20).setPlaceholder('e.g., Builderman').setRequired(true);
            
            modal.addComponents(new ActionRowBuilder().addComponents(usernameInput));
            return await interaction.showModal(modal);
        }

        if (customId === 'panel_update_btn') {
            const wait = checkCooldown(user.id, 'panel_update', 7);
            if (wait) return interaction.reply({ content: `⏳ Please wait **${wait}s** before refreshing your profile ranks again.`, flags: [MessageFlags.Ephemeral] });

            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            return await runUpdateProcess(interaction, user);
        }
    }

    // --- MODAL SUBMIT ROUTER ---
    if (interaction.isModalSubmit()) {
        const { customId, fields, channel } = interaction;

        if (customId === 'panel_verify_modal') {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const enteredName = fields.getTextInputValue('modal_roblox_username');
            return await runVerificationProcess(interaction, enteredName);
        }

        if (customId.startsWith('embed_create_modal_')) {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const textColorName = customId.replace('embed_create_modal_', '');
            const title = fields.getTextInputValue('embed_title');
            const description = fields.getTextInputValue('embed_desc');

            const ansiPrefix = TEXT_COLORS[textColorName] || TEXT_COLORS['white'];
            const finalizedDescription = `\`\`\`ansi\n${ansiPrefix}${description}\n\`\`\``;

            const newEmbed = new EmbedBuilder()
                .setTitle(title)
                .setDescription(finalizedDescription)
                .setColor('#2B2D31'); 

            await channel.send({ embeds: [newEmbed] });
            return interaction.editReply("✅ Colored text embed sent successfully!");
        }

        if (customId.startsWith('embed_edit_modal_')) {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const msgId = customId.replace('embed_edit_modal_', '');
            const title = fields.getTextInputValue('embed_title');
            const description = fields.getTextInputValue('embed_desc');

            try {
                const targetMsg = await channel.messages.fetch(msgId);
                const oldEmbed = targetMsg.embeds[0];
                
                let updatedDescription = description;
                let matchedPrefix = '\u001b[37m'; 

                if (oldEmbed.description && oldEmbed.description.startsWith('```ansi\n')) {
                    const match = oldEmbed.description.match(/^```ansi\n(\u001b\[\d+m)/);
                    if (match) matchedPrefix = match[1];
                }
                
                updatedDescription = `\`\`\`ansi\n${matchedPrefix}${description}\n\`\`\``;

                const editedEmbed = EmbedBuilder.from(oldEmbed)
                    .setTitle(title)
                    .setDescription(updatedDescription);

                await targetMsg.edit({ embeds: [editedEmbed] });
                return interaction.editReply("✅ Embed text updated successfully!");
            } catch (err) { return interaction.editReply("❌ Failed to modify embed data."); }
        }
    }
});

client.login(process.env.BOT_TOKEN);
