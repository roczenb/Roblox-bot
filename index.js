const { 
    Client, 
    GatewayIntentBits, 
    REST, 
    Routes, 
    SlashCommandBuilder, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    MessageFlags,
    PermissionFlagsBits,
    ChannelType,
    MessageType,
    AuditLogEvent
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
        GatewayIntentBits.GuildInvites,
        GatewayIntentBits.GuildModeration
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
    security: {},
    autoroles: {}, 
    milestoneRoles: {}, 
    milestoneThresholds: {},
    // SEGREGATED SYSTEM LOG STRUCTURE PIPELINES
    logsChannels: {
        system: null,      // Main server updates, bans, kicks, timeouts, purges
        moderator: null,   // Message deletes and message edits
        movement: null     // Member join/leave, role adds/removes
    },
    ticketCounter: {}
};

const verificationCodes = new Map();
const LC_ROLE_NAME = "~{}~ Lead Command ~{}~"; 
const ANTIMENTION_BYPASS_ROLE = "Speaker of the Senate"; 

const cooldowns = new Map();
const guildInvitesCache = new Map();
const auditTracking = new Map();

function loadData() {
    try {
        const dir = path.dirname(DB_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (fs.existsSync(DB_FILE)) {
            data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            if (!data.users) data.users = {};
            if (!data.groups) data.groups = {};
            if (!data.binds) data.binds = {};
            if (!data.antimention) data.antimention = {};
            if (!data.protectedTargets) data.protectedTargets = {};
            if (!data.invites) data.invites = {};
            if (!data.logs) data.logs = {};
            if (!data.security) data.security = {};
            if (!data.autoroles) data.autoroles = {};
            if (!data.milestoneRoles) data.milestoneRoles = {};
            if (!data.milestoneThresholds) data.milestoneThresholds = {};
            if (!data.logsChannels) data.logsChannels = { system: null, moderator: null, movement: null };
            if (!data.ticketCounter) data.ticketCounter = {};
        }
    } catch (e) { console.log("Data loaded smoothly."); }
}

function saveData() {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); } catch (e) { console.error(e); }
}

loadData();

// ROUTER PIPELINE FOR SEGREGATED TRACKING SYSTEM LOGS
function dispatchLog(guildId, targetPipeline, logPayload) {
    const channelId = data.logsChannels?.[targetPipeline]?.[guildId] || data.logsChannels?.[targetPipeline];
    if (!channelId) return;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    const targetChannel = guild.channels.cache.get(channelId);
    if (targetChannel && targetChannel.isTextBased()) {
        targetChannel.send(logPayload).catch(err => console.error(`Log Routing error inside [${targetPipeline}]:`, err.message));
    }
}

function checkCooldown(userId, commandName, seconds = 5) {
    const key = `${userId}-${commandName}`;
    const now = Date.now();
    if (cooldowns.has(key)) {
        const expirationTime = cooldowns.get(key) + (seconds * 1000);
        if (now < expirationTime) return ((expirationTime - now) / 1000).toFixed(1);
    }
    cooldowns.set(key, now);
    setTimeout(() => cooldowns.delete(key), seconds * 1000);
    return null;
}

const commands = [
    new SlashCommandBuilder().setName('verify').setDescription('Link a Roblox account globally')
        .addStringOption(o => o.setName('username').setDescription('Username').setRequired(true))
        .addUserOption(o => o.setName('target').setDescription('Admin Only: Target user to verify for them').setRequired(false)),
    new SlashCommandBuilder().setName('setup-group').setDescription('Link a Roblox Group ID to this server').addStringOption(o => o.setName('groupid').setDescription('Group ID').setRequired(true)),
    new SlashCommandBuilder().setName('sync-group-roles').setDescription('Auto create and bind roles sorted perfectly by chain of command hierarchy'),
    new SlashCommandBuilder().setName('bind').setDescription('Bind a specific rank to a role')
        .addIntegerOption(o => o.setName('rankid').setDescription('Rank').setRequired(true))
        .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true))
        .addStringOption(o => o.setName('nickname-format').setDescription('Format, e.g: E1 | {roblox_username}').setRequired(false))
        .addIntegerOption(o => o.setName('min-invites').setDescription('Minimum required invites').setRequired(false)),
    new SlashCommandBuilder().setName('update').setDescription('Sync ranks in this server').addUserOption(o => o.setName('user').setDescription('Admin Only: Target user to update').setRequired(false)),
    new SlashCommandBuilder().setName('sync-milestones').setDescription('Admin Only: Force re-verify and evaluate batch division rules for a member').addUserOption(o => o.setName('target').setDescription('The trooper to sync tier roles for').setRequired(true)),
    new SlashCommandBuilder().setName('setup-milestones').setDescription('Admin Only: Configure multiple roles awarded to anyone AT or ABOVE a certain Roblox rank')
        .addStringOption(o => o.setName('category-name').setDescription('Label for this threshold pool (e.g. Officer Pack)').setRequired(true))
        .addStringOption(o => o.setName('roles-list').setDescription('Comma separated list of multiple roles (e.g. @Role1, @Role2)').setRequired(true))
        .addIntegerOption(o => o.setName('min-rank').setDescription('The minimum Roblox rank number required (e.g. 30)').setRequired(true)),
    
    // CONVERGED MULTI-CHANNEL DETAILED SYSTEM CONFIGURATION LOG SELECTION
    new SlashCommandBuilder().setName('setup-logs').setDescription('Admin Only: Route logs to independent tracking stations')
        .addStringOption(o => o.setName('category').setDescription('Select targeting track pipeline category').setRequired(true)
            .addChoices(
                { name: 'System Logs (Purge, Kick, Ban, Timeouts, Server/Channel Changes)', value: 'system' },
                { name: 'Moderator Logs (Message Edits, Message Deletions)', value: 'moderator' },
                { name: 'Join-Leave Logs (Joins, Leaves, Role Updates)', value: 'movement' }
            ))
        .addChannelOption(o => o.setName('channel').setDescription('Target stream destination channel text frame').setRequired(true)),

    new SlashCommandBuilder().setName('view-binds').setDescription('View all Roblox rank-to-role connections for this server'),
    new SlashCommandBuilder().setName('updateall').setDescription('Lead Command Only: Update every verified member in the server at once'),
    new SlashCommandBuilder().setName('verification-panel').setDescription('Admin Only: Post the interactive verification embed panel with buttons'),
    new SlashCommandBuilder().setName('autorole').setDescription('Admin Only: Add/remove an entry role, or view active configurations')
        .addRoleOption(o => o.setName('role').setDescription('The role to toggle on/off for welcome assignment').setRequired(false)),
    new SlashCommandBuilder().setName('antimention').setDescription('Admin Only: Toggle shield settings')
        .addBooleanOption(o => o.setName('enabled').setDescription('Turn anti-mention filter on or off').setRequired(true))
        .addUserOption(o => o.setName('protect-user').setDescription('Nuke messages that mention this specific user').setRequired(false))
        .addRoleOption(o => o.setName('protect-role').setDescription('Nuke messages that mention this specific role').setRequired(false)),
    new SlashCommandBuilder().setName('antimention-remove').setDescription('Admin Only: Completely wipe anti-mention shield constraints'),
    new SlashCommandBuilder().setName('embed-create').setDescription('Admin Only: Create a custom embed message')
        .addStringOption(o => o.setName('text-color').setDescription('Color of the description text').setRequired(false)
            .addChoices(
                { name: 'Red', value: 'red' }, { name: 'Green', value: 'green' }, { name: 'Yellow', value: 'yellow' },
                { name: 'Blue', value: 'blue' }, { name: 'Magenta', value: 'magenta' }, { name: 'Cyan', value: 'cyan' }, { name: 'White', value: 'white' }
            )),
    new SlashCommandBuilder().setName('embed-edit').setDescription('Admin Only: Modify an existing bot embed')
        .addStringOption(o => o.setName('message-id').setDescription('The ID of the bot message containing the embed').setRequired(true)),
    new SlashCommandBuilder().setName('invites-leaderboard').setDescription('View the server detailed invite leaderboard metrics'),
    new SlashCommandBuilder().setName('security-config').setDescription('Configure automated Beast Mode parameters')
        .addBooleanOption(o => o.setName('active').setDescription('Enable structural system defense updates').setRequired(true))
        .addIntegerOption(o => o.setName('beast-threshold').setDescription('Deletions within 15s to lock server (Default: 4)').setRequired(false)),
    new SlashCommandBuilder().setName('beast-disable').setDescription('Deactivate active server Beast Mode lockdown constraints'),
    new SlashCommandBuilder().setName('ban').setDescription('Admin Only: Ban a member').addUserOption(o => o.setName('target').setDescription('User').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),
    new SlashCommandBuilder().setName('unban').setDescription('Admin Only: Unban a user by ID').addStringOption(o => o.setName('userid').setDescription('Discord User ID').setRequired(true)),
    new SlashCommandBuilder().setName('kick').setDescription('Admin Only: Kick a member').addUserOption(o => o.setName('target').setDescription('User').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),
    new SlashCommandBuilder().setName('timeout').setDescription('Admin Only: Timeout a member').addUserOption(o => o.setName('target').setDescription('User').setRequired(true)).addIntegerOption(o => o.setName('minutes').setDescription('Duration in minutes').setRequired(true)),
    new SlashCommandBuilder().setName('unmute').setDescription('Admin Only: Lift an active timeout from a member').addUserOption(o => o.setName('target').setDescription('User').setRequired(true)),
    new SlashCommandBuilder().setName('say').setDescription('Make the bot echo text messages').addStringOption(o => o.setName('text').setDescription('Text message to broadcast').setRequired(true)),
    new SlashCommandBuilder().setName('giveaway').setDescription('Manage community giveaways').addSubcommand(s => s.setName('create').setDescription('Initialize a server giveaway package')),
    new SlashCommandBuilder().setName('tickets').setDescription('Manage the ticketing system pipeline')
        .addSubcommand(s => s.setName('setup').setDescription('Admin Only: Send the interactive support panel to this channel')),
    
    // EXPLICIT BOT PURGE COMMAND
    new SlashCommandBuilder().setName('purge').setDescription('Admin Only: Delete a bulk amount of text packets instantly from this stream channel')
        .addIntegerOption(o => o.setName('amount').setDescription('Number of system elements to dump (Max 100)').setRequired(true))
].map(c => c.toJSON());

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    for (const [guildId, guild] of client.guilds.cache) {
        try {
            const firstInvites = await guild.invites.fetch();
            guildInvitesCache.set(guild.id, new Map(firstInvites.map(invite => [invite.code, invite.uses])));
        } catch (err) { console.log(`Invite monitoring limitations check.`); }
    }
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
        await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
        const guilds = await client.guilds.fetch();
        for (const [guildId] of guilds) {
            await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
        }
        console.log('Segregated logging slash elements deployed!');
    } catch (e) { console.error(e); }
});

client.on('inviteCreate', invite => {
    const cache = guildInvitesCache.get(invite.guild.id);
    if (cache) cache.set(invite.code, invite.uses);
});

// PIPELINE 3: MOVEMENT TRACK LOGS (GUILD MEMBER ADD)
client.on('guildMemberAdd', async member => {
    if (data.security[member.guild.id]?.beastMode) {
        try {
            await member.send("⚠️ This server is under high security lockdown.");
            await member.kick("Beast Mode Activity Mitigation Rules");
            dispatchLog(member.guild.id, 'system', `🚨 **Beast Mode Security Tripped:** Kicked incoming user <@${member.id}> to maintain perimeter integrity.`);
            return;
        } catch (e) { console.error(e); }
    }

    const activeAutoRoleIds = data.autoroles?.[member.guild.id];
    if (Array.isArray(activeAutoRoleIds) && activeAutoRoleIds.length > 0) {
        for (const rId of activeAutoRoleIds) {
            const targetJoinRole = member.guild.roles.cache.get(rId);
            if (targetJoinRole) await member.roles.add(targetJoinRole).catch(() => {});
        }
    }

    const cachedInvites = guildInvitesCache.get(member.guild.id);
    const newInvites = await member.guild.invites.fetch().catch(() => null);
    let usedBy = "Unknown", inviteCodeUsed = "";

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
        if (!data.invites[member.guild.id][usedBy]) data.invites[member.guild.id][usedBy] = { regular: 0, left: 0, fake: 0, bonus: 0 };
        data.invites[member.guild.id][usedBy].regular += 1;
        data.logs[member.id] = { inviter: usedBy, code: inviteCodeUsed };
        saveData();
    }

    const joinEmbed = new EmbedBuilder()
        .setTitle("📥 Member Joined Connection")
        .setColor(0x2ECC71)
        .setDescription(`<@${member.id}> linked up to the tracking grid.\n**Invited By:** <@${usedBy}>\n**Invitation Code:** \`${inviteCodeUsed || 'N/A'}\``)
        .setTimestamp();
    dispatchLog(member.guild.id, 'movement', { embeds: [joinEmbed] });
});

// PIPELINE 3: MOVEMENT TRACK LOGS (GUILD MEMBER REMOVE)
client.on('guildMemberRemove', async member => {
    const log = data.logs[member.id];
    let inviterString = "Unknown Grid Agent";
    if (log && data.invites[member.guild.id]?.[log.inviter]) {
        data.invites[member.guild.id][log.inviter].left += 1;
        saveData();
        inviterString = `<@${log.inviter}>`;
    }

    const leaveEmbed = new EmbedBuilder()
        .setTitle("📤 Member Severed Connection")
        .setColor(0xE74C3C)
        .setDescription(`<@${member.id}> left or disconnected from the core.\n**Original Anchor:** ${inviterString}`)
        .setTimestamp();
    dispatchLog(member.guild.id, 'movement', { embeds: [leaveEmbed] });
});

// PIPELINE 3: MOVEMENT TRACK LOGS (GUILD MEMBER UPDATE - ROLES POOL CHANGE)
client.on('guildMemberUpdate', async (oldMember, newMember) => {
    const oldRoles = oldMember.roles.cache;
    const newRoles = newMember.roles.cache;

    if (oldRoles.size !== newRoles.size) {
        const addedRoles = newRoles.filter(role => !oldRoles.has(role.id));
        const removedRoles = oldRoles.filter(role => !newRoles.has(role.id));

        const updateEmbed = new EmbedBuilder()
            .setTitle("🛡️ Member Role Status Modification")
            .setColor(0x9B59B6)
            .setAuthor({ name: newMember.user.tag, iconURL: newMember.user.displayAvatarURL() })
            .setDescription(`**Target Account:** <@${newMember.id}>`)
            .setTimestamp();

        if (addedRoles.size > 0) {
            updateEmbed.addFields({ name: "➕ Granted Identity Role:", value: addedRoles.map(r => `<@&${r.id}>`).join(', ') });
        }
        if (removedRoles.size > 0) {
            updateEmbed.addFields({ name: "➖ Revoked Identity Role:", value: removedRoles.map(r => `<@&${r.id}>`).join(', ') });
        }

        dispatchLog(newMember.guild.id, 'movement', { embeds: [updateEmbed] });
    }
});

// PIPELINE 2: MODERATOR-ONLY CHANNEL ACTIONS (MESSAGE UPDATE)
client.on('messageUpdate', async (oldMessage, newMessage) => {
    if (oldMessage.author?.bot || oldMessage.content === newMessage.content) return;

    const editEmbed = new EmbedBuilder()
        .setTitle("📝 Text Packet Edited")
        .setColor(0xF1C40F)
        .setAuthor({ name: oldMessage.author?.tag || 'Unknown Account', iconURL: oldMessage.author?.displayAvatarURL() })
        .setDescription(`**Author:** <@${oldMessage.author?.id}>\n**Location:** <#${oldMessage.channel.id}>`)
        .addFields(
            { name: "Original Payload Content", value: oldMessage.content ? oldMessage.content.slice(0, 1024) : "*Empty/Embed*" },
            { name: "Revised Transmission Stream", value: newMessage.content ? newMessage.content.slice(0, 1024) : "*Empty/Embed*" }
        )
        .setTimestamp();
    dispatchLog(oldMessage.guildId, 'moderator', { embeds: [editEmbed] });
});

// PIPELINE 2: MODERATOR-ONLY CHANNEL ACTIONS (MESSAGE DELETE)
client.on('messageDelete', async message => {
    if (message.author?.bot) return;

    const deleteEmbed = new EmbedBuilder()
        .setTitle("🗑️ Text Transmission Purged / Deleted")
        .setColor(0xE67E22)
        .setAuthor({ name: message.author?.tag || 'Unknown Account', iconURL: message.author?.displayAvatarURL() })
        .setDescription(`**Author:** <@${message.author?.id}>\n**Location Zone:** <#${message.channel.id}>`)
        .addFields({ name: "Erased Content Data Block", value: message.content ? message.content.slice(0, 1024) : "*Empty context or Media file*" })
        .setTimestamp();
    dispatchLog(message.guildId, 'moderator', { embeds: [deleteEmbed] });
});

// PIPELINE 1: CORE DISCORD SERVER UPDATES (CHANNEL CREATION INTERCEPT)
client.on('channelCreate', async channel => {
    if (!channel.guild) return;
    const createEmbed = new EmbedBuilder()
        .setTitle("✨ Matrix Channel Generated")
        .setColor(0x3498DB)
        .setDescription(`**Name:** \`${channel.name}\`\n**Identity Route:** <#${channel.id}>\n**Type Config:** Channel Type Category ID [${channel.type}]`)
        .setTimestamp();
    dispatchLog(channel.guild.id, 'system', { embeds: [createEmbed] });
});

// PIPELINE 1: CORE DISCORD SERVER UPDATES (CHANNEL UPDATE / PERM OVERWRITES)
client.on('channelUpdate', async (oldChannel, newChannel) => {
    if (!oldChannel.guild) return;
    
    // Look to see if permission strings were altered
    if (JSON.stringify(oldChannel.permissionOverwrites.cache) !== JSON.stringify(newChannel.permissionOverwrites.cache)) {
        const permEmbed = new EmbedBuilder()
            .setTitle("🔒 Channel Perimeter Security Policy Altered")
            .setColor(0x34495E)
            .setDescription(`Core permission map adjustments processed inside tracking grid:\n**Target Route:** <#${newChannel.id}> (\`${newChannel.name}\`)`)
            .setTimestamp();
        dispatchLog(newChannel.guild.id, 'system', { embeds: [permEmbed] });
    }
});

function incrementSecurityTrigger(guildId) {
    if (!data.security[guildId]) data.security[guildId] = { enabled: true, beastMode: false, limit: 4 };
    if (!data.security[guildId].enabled) return;

    const now = Date.now();
    if (!auditTracking.has(guildId)) auditTracking.set(guildId, []);
    const timestamps = auditTracking.get(guildId);
    timestamps.push(now);
    const dynamicFilter = timestamps.filter(time => now - time < 15000);
    auditTracking.set(guildId, dynamicFilter);

    const criticalThreshold = data.security[guildId].limit || 4;
    if (dynamicFilter.length >= criticalThreshold && !data.security[guildId].beastMode) {
        data.security[guildId].beastMode = true;
        saveData();
        const msg = `🚨 **SECURITY ALERT:** Rapid structural deletions detected (${dynamicFilter.length}/${criticalThreshold})! **BEAST MODE ENABLED.**`;
        dispatchLog(guildId, 'system', msg);
    }
}

client.on('channelDelete', channel => { 
    if (channel.guild) {
        const delEmbed = new EmbedBuilder().setTitle("🚨 Channel Deleted Structural Shift").setColor(0xD35400).setDescription(`Channel Named \`${channel.name}\` was permanently expunged.`).setTimestamp();
        dispatchLog(channel.guild.id, 'system', { embeds: [delEmbed] });
        incrementSecurityTrigger(channel.guild.id); 
    }
});
client.on('roleDelete', role => { if (role.guild) incrementSecurityTrigger(role.guild.id); });

// GLOBAL MESSAGES ESCORT SHIELD INTERCEPTOR
client.on('messageCreate', async message => {
    if (!message.guild || message.author.bot) return;

    const isEnabled = data.antimention ? data.antimention[message.guild.id] : false;
    if (!isEnabled) return;

    const hasBypassRole = message.member.roles.cache.some(r => r.name === ANTIMENTION_BYPASS_ROLE);
    const isAdmin = message.member.permissions.has(PermissionFlagsBits.Administrator);
    if (isAdmin || hasBypassRole) return; 

    const totalMentions = message.mentions.users.size + message.mentions.roles.size;
    const targetConfig = data.protectedTargets ? data.protectedTargets[message.guild.id] : null;
    let triggeredProtection = false, protectionReason = "";
    const isDiscordReply = message.type === MessageType.Reply;

    if (targetConfig && !isDiscordReply) {
        if (targetConfig.userId && message.mentions.users.has(targetConfig.userId)) {
            triggeredProtection = true;
            protectionReason = `pings to <@${targetConfig.userId}> are strictly forbidden unless replying`;
        }
        if (targetConfig.roleId && message.mentions.roles.has(targetConfig.roleId)) {
            triggeredProtection = true;
            protectionReason = `pings to <@&${targetConfig.roleId}> are strictly forbidden`;
        }
    }

    if ((totalMentions > 4 && !isDiscordReply) || triggeredProtection) {
        if (!protectionReason) protectionReason = "mass mentions are restricted while the anti-mention shield is active";
        try {
            await message.delete();
            dispatchLog(message.guild.id, 'moderator', `🛡️ **Anti-Mention Shield Cleaned Layer:** Blocked a transmission string from <@${message.author.id}> inside <#${message.channel.id}> due to restriction violation.`);
            const warning = await message.channel.send(`⚠️ <@${message.author.id}>, ${protectionReason}.`);
            setTimeout(() => warning.delete().catch(() => {}), 5000);
        } catch (err) { console.log(err.message); }
    }
});

async function applyUserRankMutations(member, robloxId, bindConfig, username) {
    if (bindConfig.nicknameFormat) {
        let structuredName = bindConfig.nicknameFormat.replace('{roblox_username}', username);
        if (structuredName.length <= 32) await member.setNickname(structuredName).catch(() => {});
    }
}

async function runVerificationProcess(interaction, usernameInput, targetUser) {
    try {
        const res = await axios.post('https://users.roproxy.com/v1/usernames/users', { usernames: [usernameInput], excludeBannedUsers: true });
        if (!res.data.data.length) return interaction.editReply("❌ User not found on Roblox.");
        const rId = res.data.data[0].id;
        
        const lookupKey = `verify_${interaction.user.id}`;
        const activePendingCode = verificationCodes.get(lookupKey);
        const profileLookup = await axios.get(`https://users.roproxy.com/v1/users/${rId}`);
        const userDescription = profileLookup.data.description || "";

        if (!activePendingCode || !userDescription.includes(activePendingCode)) {
            const generatedSecretCode = `CT-${Math.floor(100000 + Math.random() * 900000)}`;
            verificationCodes.set(lookupKey, generatedSecretCode);

            const challengeEmbed = new EmbedBuilder()
                .setTitle("🛡️ Confirm Profile Ownership")
                .setDescription(`To verify as **${usernameInput}**, please append the security token inside your Roblox account Bio description.\n\nOnce updated, rerun the command \`/verify username:${usernameInput}\` to link successfully.`)
                .addFields({ name: "Required Verification Key:", value: `\`${generatedSecretCode}\`` })
                .setColor(0xF1C40F);
            
            return interaction.editReply({ embeds: [challengeEmbed] });
        }

        verificationCodes.delete(lookupKey);
        data.users[targetUser.id] = rId;
        saveData();

        const logEmbed = new EmbedBuilder()
            .setTitle("🔑 Account Verified")
            .setColor(0x3498DB)
            .addFields(
                { name: "Target User:", value: `<@${targetUser.id}>`, inline: true },
                { name: "Roblox Identity:", value: `\`${usernameInput}\` (\`${rId}\`)`, inline: true }
            );
        dispatchLog(interaction.guildId, 'movement', { embeds: [logEmbed] });

        return interaction.editReply(`✅ Successfully verified <@${targetUser.id}> globally as Roblox ID: ${rId}`);
    } catch (e) { return interaction.editReply(`❌ Error: ${e.message}`); }
}

async function runUpdateProcess(interaction, targetUser) {
    const robloxId = data.users[targetUser.id];
    if (!robloxId) return interaction.editReply("❌ Connect identity profile link using `/verify` first.");
    
    const serverBinds = data.binds ? data.binds[interaction.guildId] : [];
    const userInvData = data.invites[interaction.guildId]?.[targetUser.id] || { regular: 0, left: 0 };
    const netInvites = userInvData.regular - userInvData.left;

    try {
        let added = [], removed = [];
        const targetMember = await interaction.guild.members.fetch(targetUser.id);
        const gRes = await axios.get(`https://groups.roproxy.com/v2/users/${robloxId}/groups/roles`);
        const uLookup = await axios.get(`https://users.roproxy.com/v1/users/${robloxId}`);
        const robloxName = uLookup.data.name;
        
        const sRolesMap = data.milestoneRoles[interaction.guildId] || {};
        const sThresholds = data.milestoneThresholds[interaction.guildId] || {};
        const primaryGroupId = data.groups?.[interaction.guildId];
        
        if (!primaryGroupId) return interaction.editReply("❌ Primary Roblox group configuration missing.");
        
        const primaryMatch = gRes.data.data.find(g => g.group.id.toString() === primaryGroupId.toString());
        const mainGroupRank = primaryMatch ? primaryMatch.role.rank : 0;

        for (const b of serverBinds) {
            const role = interaction.guild.roles.cache.get(b.roleId);
            if (role) {
                const currentBindGroupMatch = gRes.data.data.find(g => g.group.id.toString() === b.groupId.toString());
                const specificUserRank = currentBindGroupMatch ? currentBindGroupMatch.role.rank : 0;

                if (specificUserRank === b.rankId && netInvites >= (b.minInvites || 0)) { 
                    if (!targetMember.roles.cache.has(role.id)) { await targetMember.roles.add(role); added.push(role.name); }
                    await applyUserRankMutations(targetMember, robloxId, b, robloxName);
                } else if (targetMember.roles.cache.has(role.id)) { await targetMember.roles.remove(role); removed.push(role.name); }
            }
        }

        for (const [categoryKey, roleIdsArray] of Object.entries(sRolesMap)) {
            const minRequiredRank = sThresholds[categoryKey] ?? 0;
            const qualifies = mainGroupRank >= minRequiredRank;
            if (Array.isArray(roleIdsArray)) {
                for (const rId of roleIdsArray) {
                    const discordRole = interaction.guild.roles.cache.get(rId);
                    if (!discordRole) continue;
                    const hasRole = targetMember.roles.cache.has(rId);
                    if (qualifies && !hasRole) { await targetMember.roles.add(discordRole).catch(() => {}); added.push(discordRole.name); }
                    else if (!qualifies && hasRole) { await targetMember.roles.remove(discordRole).catch(() => {}); removed.push(discordRole.name); }
                }
            }
        }

        const embed = new EmbedBuilder()
            .setTitle("Clone Trooper Profile Synced")
            .setColor(0x2ECC71) 
            .addFields(
                { name: "Trooper Target Account:", value: `<@${targetUser.id}>`, inline: true },
                { name: "Group Rank ID:", value: `\`${mainGroupRank}\``, inline: true }
            );
        return interaction.editReply({ embeds: [embed] });
    } catch (e) { return interaction.editReply("❌ Update network handling threshold sequence code execution block error."); }
}

client.on('interactionCreate', async interaction => {
    if (interaction.isButton()) {
        if (interaction.customId === 'panel_update_btn') {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            return await runUpdateProcess(interaction, interaction.user);
        }
        if (interaction.customId === 'panel_link_btn') {
            return interaction.reply({ content: "Execute command `/verify` to associate identity profile details.", flags: [MessageFlags.Ephemeral] });
        }

        if (interaction.customId === 'open_ticket_btn') {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            if (!data.ticketCounter[interaction.guildId]) data.ticketCounter[interaction.guildId] = 0;
            data.ticketCounter[interaction.guildId]++;
            saveData();

            const countStr = data.ticketCounter[interaction.guildId].toString().padStart(4, '0');
            try {
                const ticketChannel = await interaction.guild.channels.create({
                    name: `ticket-${countStr}`,
                    type: ChannelType.GuildText,
                    permissionOverwrites: [
                        { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
                    ]
                });

                const welcomeTicketEmbed = new EmbedBuilder().setTitle(`🎫 Support Ticket #${countStr}`).setDescription(`Greetings <@${interaction.user.id}>,\n\nPlease supply your operational issue parameters here explicitly.`).setColor(0x3498DB);
                const closeActionRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('close_ticket_btn').setLabel('Close Ticket').setStyle(ButtonStyle.Danger));

                await ticketChannel.send({ embeds: [welcomeTicketEmbed], components: [closeActionRow] });
                dispatchLog(interaction.guildId, 'system', `🎟️ **Ticket Opened:** <@${interaction.user.id}> initialized support workspace entry channel frame <#${ticketChannel.id}>.`);
                return interaction.editReply(`✅ Support channel link built: <#${ticketChannel.id}>`);
            } catch (err) { return interaction.editReply("❌ Pipeline permission allocation error."); }
        }

        if (interaction.customId === 'close_ticket_btn') {
            await interaction.reply({ content: "🔒 Terminating and closing channel workspace track frame in 5 seconds..." });
            dispatchLog(interaction.guildId, 'system', `🗑️ **Ticket Closed:** Workspace tracking window \`${interaction.channel.name}\` dropped.`);
            setTimeout(() => { interaction.channel.delete().catch(() => {}); }, 5000);
            return;
        }
    }

    if (!interaction.isChatInputCommand()) return;
    const { commandName, options, guildId, member, channel } = interaction;

    // SEGREGATED INTERACTIVE MULTI-LOG DISPATCH ASSIGNMENT STATION SETUP COMMAND
    if (commandName === 'setup-logs') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        
        const categorySelection = options.getString('category');
        const targetChannel = options.getChannel('channel');

        if (!targetChannel.isTextBased()) return interaction.editReply("❌ Target allocation selection must be text-based.");
        
        if (!data.logsChannels) data.logsChannels = { system: null, moderator: null, movement: null };
        if (typeof data.logsChannels[categorySelection] !== 'object' || data.logsChannels[categorySelection] === null) {
            data.logsChannels[categorySelection] = {};
        }
        
        data.logsChannels[categorySelection][guildId] = targetChannel.id;
        saveData();

        return interaction.editReply(`✅ **Segregated Log Channel Binding Complete:** Category **[${categorySelection}]** streams are now routing into channel: <#${targetChannel.id}>.`);
    }

    // DISCORD INTERACTION LOGIC COMMAND PIPELINE ENTRIES
    if (commandName === 'purge') {
        if (!member.permissions.has(PermissionFlagsBits.ManageMessages)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        const targetAmount = options.getInteger('amount');
        if (targetAmount < 1 || targetAmount > 100) return interaction.editReply("❌ Clear metrics scope constraints must remain between 1 and 100 entries.");

        const clearPackets = await channel.bulkDelete(targetAmount, true).catch(() => []);
        
        const purgeEmbed = new EmbedBuilder()
            .setTitle("🧹 Channel Text Stream Purged")
            .setColor(0x95A5A6)
            .setDescription(`**Moderator Execution:** <@${member.id}>\n**Target Location Channel:** <#${channel.id}>\n**Packets Dropped:** \`${clearPackets.size}\` entries.`)
            .setTimestamp();
        dispatchLog(guildId, 'system', { embeds: [purgeEmbed] });

        return interaction.editReply(`✅ Text purge sequence finalized. Cleared \`${clearPackets.size}\` records.`);
    }

    if (commandName === 'autorole') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        const selectedRole = options.getRole('role');
        if (!data.autoroles) data.autoroles = {};
        if (!Array.isArray(data.autoroles[guildId])) data.autoroles[guildId] = [];

        if (!selectedRole) {
            const activeIds = data.autoroles[guildId];
            if (!activeIds.length) return interaction.editReply("ℹ️ No autorole configurations active on this server yet.");
            return interaction.editReply(`ℹ️ Active welcome roles pool: ${activeIds.map(id => `<@&${id}>`).join(', ')}`);
        }

        if (data.autoroles[guildId].includes(selectedRole.id)) {
            data.autoroles[guildId] = data.autoroles[guildId].filter(id => id !== selectedRole.id);
            saveData();
            return interaction.editReply(`✅ **Autorole Removed:** <@&${selectedRole.id}> dropped.`);
        } else {
            data.autoroles[guildId].push(selectedRole.id);
            saveData();
            return interaction.editReply(`✅ **Autorole Added:** <@&${selectedRole.id}> bound to welcome grid layer.`);
        }
    }

    if (commandName === 'ban') {
        if (!member.permissions.has(PermissionFlagsBits.BanMembers)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        const targetUser = options.getUser('target');
        const coreReason = options.getString('reason') || "No formal reasoning logged.";
        
        await interaction.guild.members.ban(targetUser, { reason: coreReason });
        
        const modEmbed = new EmbedBuilder().setTitle("🚨 Ban Action Registered").setColor(0xC0392B).setDescription(`**Target:** <@${targetUser.id}>\n**Execution Agent:** <@${member.id}>\n**Reasoning:** ${coreReason}`).setTimestamp();
        dispatchLog(guildId, 'system', { embeds: [modEmbed] });
        return interaction.editReply("🚨 Account banned.");
    }

    if (commandName === 'unban') {
        if (!member.permissions.has(PermissionFlagsBits.BanMembers)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        const userIdInput = options.getString('userid');
        try {
            await interaction.guild.members.unban(userIdInput);
            const modEmbed = new EmbedBuilder().setTitle("🔓 Ban Revocation Processed").setColor(0x27AE60).setDescription(`**Target ID Record:** \`${userIdInput}\` unbanned by <@${member.id}>`).setTimestamp();
            dispatchLog(guildId, 'system', { embeds: [modEmbed] });
            return interaction.editReply(`✅ Successfully unbanned user ID: \`${userIdInput}\``);
        } catch (err) { return interaction.editReply(`❌ Action failed: ${err.message}`); }
    }
    
    if (commandName === 'kick') {
        if (!member.permissions.has(PermissionFlagsBits.KickMembers)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        const targetMember = options.getMember('target');
        const coreReason = options.getString('reason') || "No formal reasoning logged.";
        
        await targetMember.kick(coreReason);
        
        const modEmbed = new EmbedBuilder().setTitle("👢 Kick Action Registered").setColor(0xD35400).setDescription(`**Target Member:** <@${targetMember.id}>\n**Execution Agent:** <@${member.id}>\n**Reasoning:** ${coreReason}`).setTimestamp();
        dispatchLog(guildId, 'system', { embeds: [modEmbed] });
        return interaction.editReply("👢 Member kicked.");
    }

    if (commandName === 'timeout') {
        if (!member.permissions.has(PermissionFlagsBits.ModerateMembers)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        const targetMember = options.getMember('target');
        const durationMins = options.getInteger('minutes');
        
        await targetMember.timeout(durationMins * 60 * 1000);
        
        const modEmbed = new EmbedBuilder().setTitle("⏳ Isolation Timeout Enforced").setColor(0xE67E22).setDescription(`**Target Member:** <@${targetMember.id}>\n**Agent Control:** <@${member.id}>\n**Metrics Scale:** Duration set to \`${durationMins}\` minutes.`).setTimestamp();
        dispatchLog(guildId, 'system', { embeds: [modEmbed] });
        return interaction.editReply("⏳ Member isolated.");
    }

    if (commandName === 'unmute') {
        if (!member.permissions.has(PermissionFlagsBits.ModerateMembers)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        const targetMember = options.getMember('target');
        if (!targetMember) return interaction.editReply("❌ Target member invalid.");
        
        await targetMember.timeout(null);
        const modEmbed = new EmbedBuilder().setTitle("🔊 Timeout Restraint Lifted").setColor(0x2ECC71).setDescription(`**Target member account:** <@${targetMember.id}> restored by <@${member.id}>.`).setTimestamp();
        dispatchLog(guildId, 'system', { embeds: [modEmbed] });
        return interaction.editReply("🔊 Isolation lifted.");
    }

    if (commandName === 'sync-milestones') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        return await runUpdateProcess(interaction, options.getUser('target'));
    }

    if (commandName === 'setup-milestones') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        const categoryName = options.getString('category-name').toLowerCase().replace(/\s+/g, '_');
        const rolesListString = options.getString('roles-list');
        const minRank = options.getInteger('min-rank');
        const parsedIds = [...rolesListString.matchAll(/\d+/g)].map(match => match[0]);

        if (!parsedIds.length) return interaction.editReply("❌ No valid Discord roles extracted.");
        if (!data.milestoneRoles) data.milestoneRoles = {};
        if (!data.milestoneThresholds) data.milestoneThresholds = {};
        if (!data.milestoneRoles[guildId]) data.milestoneRoles[guildId] = {};
        if (!data.milestoneThresholds[guildId]) data.milestoneThresholds[guildId] = {};

        data.milestoneRoles[guildId][categoryName] = parsedIds;
        data.milestoneThresholds[guildId][categoryName] = minRank;
        saveData();
        return interaction.editReply(`✅ Milestone configurations saved under key label \`${categoryName}\`.`);
    }

    if (commandName === 'bind') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        const rankId = options.getInteger('rankid');
        const role = options.getRole('role');
        const nicknameFormat = options.getString('nickname-format') || null;
        const minInvites = options.getInteger('min-invites') || 0;
        const groupId = data.groups?.[guildId];

        if (!groupId) return interaction.editReply("❌ Associate Roblox Group ID profile mapping via \`/setup-group\` first.");
        if (!data.binds[guildId]) data.binds[guildId] = [];
        data.binds[guildId] = data.binds[guildId].filter(b => !(b.groupId === groupId && b.rankId === rankId));
        
        data.binds[guildId].push({ groupId, rankId, roleId: role.id, nicknameFormat, minInvites });
        saveData();
        return interaction.editReply(`✅ Bound Rank \`${rankId}\` directly to role target <@&${role.id}>.`);
    }

    if (commandName === 'antimention') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        const enabledSetting = options.getBoolean('enabled');
        const protectUser = options.getUser('protect-user');
        const protectRole = options.getRole('protect-role');

        if (!data.antimention) data.antimention = {};
        if (!data.protectedTargets) data.protectedTargets = {};
        data.antimention[guildId] = enabledSetting;

        if (enabledSetting) {
            data.protectedTargets[guildId] = { userId: protectUser ? protectUser.id : null, roleId: protectRole ? protectRole.id : null };
        }
        saveData();
        return interaction.editReply(`🛡️ Anti-Mention tracking parameters synchronized successfully.`);
    }

    if (commandName === 'antimention-remove') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        if (data.antimention) data.antimention[guildId] = false;
        if (data.protectedTargets) data.protectedTargets[guildId] = { userId: null, roleId: null };
        saveData();
        return interaction.editReply("✅ Anti-mention shield variables wiped clean.");
    }

    if (commandName === 'security-config') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        const activeSetting = options.getBoolean('active');
        const customThreshold = options.getInteger('beast-threshold');
        const finalLimit = customThreshold !== null ? customThreshold : (data.security[guildId]?.limit || 4);

        if (finalLimit < 1) return interaction.editReply("❌ Limit floor must exceed 0.");
        data.security[guildId] = { enabled: activeSetting, beastMode: data.security[guildId]?.beastMode || false, limit: finalLimit };
        saveData();
        return interaction.editReply(`🛡️ Automated security perimeter configuration elements locked.`);
    }

    if (commandName === 'beast-disable') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        if (data.security[guildId]) data.security[guildId].beastMode = false;
        saveData();
        return interaction.editReply("✅ **BEAST MODE EMERGENCY THRESHOLD RESET FINALIZED.**");
    }

    if (commandName === 'say') {
        if (!member.permissions.has(PermissionFlagsBits.ManageMessages)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        await channel.send(options.getString('text'));
        return interaction.editReply("Broadcast deployed.");
    }

    if (commandName === 'verification-panel') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        const panelEmbed = new EmbedBuilder().setTitle("Identity Tracking System").setDescription("Click buttons below to modify connection values.").setColor(0x355eed);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('panel_link_btn').setLabel('Link Roblox Account').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('panel_update_btn').setLabel('Update Profile Sync').setStyle(ButtonStyle.Secondary)
        );
        await channel.send({ embeds: [panelEmbed], components: [row] });
        return interaction.editReply("Deployed.");
    }

    if (commandName === 'verify') {
        const targetUser = options.getUser('target');
        if (targetUser && targetUser.id !== interaction.user.id && !member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        }
        const wait = checkCooldown(interaction.user.id, commandName, 5);
        if (wait) return interaction.reply({ content: `⏳ Cooldown active: ${wait}s`, flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        return await runVerificationProcess(interaction, options.getString('username'), targetUser || interaction.user);
    }

    if (commandName === 'tickets') {
        if (options.getSubcommand() === 'setup') {
            if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
            await interaction.deferReply();
            const ticketEmbed = new EmbedBuilder().setTitle("🎫 Support Desk Operations Panel").setDescription("Engage the ticket creation module to lock a transmission line to support.").setColor(0x2ECC71);
            const btnRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_ticket_btn').setLabel('Open Support Request Container').setStyle(ButtonStyle.Primary).setEmoji('📩'));
            await channel.send({ embeds: [ticketEmbed], components: [btnRow] });
            return interaction.editReply("✅ Interactive support layout panel matrix online.");
        }
    }

    if (commandName === 'setup-group') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        if (!data.groups) data.groups = {};
        data.groups[guildId] = options.getString('groupid');
        saveData();
        return interaction.editReply("✅ Core primary Group mapping assignment successful.");
    }

    if (commandName === 'sync-group-roles') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        const gId = data.groups ? data.groups[guildId] : null;
        if (!gId) return interaction.editReply("❌ Set target Group link first via \`/setup-group\`.");
        try {
            const rRoles = (await axios.get(`https://groups.roproxy.com/v1/groups/${gId}/roles`)).data.roles.filter(r => r.rank > 0).sort((a, b) => a.rank - b.rank);
            if (!data.binds[guildId]) data.binds[guildId] = [];
            const existingRoles = await interaction.guild.roles.fetch();

            for (const r of rRoles) {
                data.binds[guildId] = data.binds[guildId].filter(b => !(b.groupId === gId && b.rankId === r.rank));
                let existingRole = existingRoles.find(role => role.name === r.name);
                if (!existingRole) existingRole = await interaction.guild.roles.create({ name: r.name, reason: 'Auto-sync hierarchy mapping' });
                data.binds[guildId].push({ groupId: gId, rankId: r.rank, roleId: existingRole.id, nicknameFormat: null, minInvites: 0 });
            }
            saveData();
            return interaction.editReply("🎉 Structural hierarchy roles sync cycle finished perfectly.");
        } catch (e) { return interaction.editReply(`❌ Execution anomaly failure: ${e.message}`); }
    }

    if (commandName === 'view-binds') {
        await interaction.deferReply();
        const serverBinds = data.binds ? data.binds[guildId] : [];
        if (!serverBinds.length) return interaction.editReply("❌ Configuration records clear.");
        let bindList = serverBinds.map(b => `• **Rank ID ${b.rankId}** linked directly to target element role <@&${b.roleId}>`);
        return interaction.editReply({ embeds: [new EmbedBuilder().setTitle("Active Bind Track Arrays").setDescription(bindList.join('\n'))] });
    }

    if (commandName === 'update') {
        await interaction.deferReply();
        const targetUser = options.getUser('user') || interaction.user;
        if (targetUser.id !== interaction.user.id && !member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.editReply("❌ Profile synchronization authorization breach.");
        }
        return await runUpdateProcess(interaction, targetUser);
    }

    if (commandName === 'invites-leaderboard') {
        await interaction.deferReply();
        const serverInvs = data.invites[guildId] || {};
        const sorted = Object.entries(serverInvs).map(([id, val]) => ({ id, total: (val.regular || 0) - (val.left || 0) + (val.bonus || 0) })).sort((a, b) => b.total - a.total).slice(0, 10);
        if (!sorted.length) return interaction.editReply("No active invite fields compiled.");
        let lines = sorted.map((u, i) => `\`#${i + 1}\` <@${u.id}> total score: **${u.total}** functional metric invitations.`);
        return interaction.editReply({ embeds: [new EmbedBuilder().setTitle("Invitation Analytics Grid").setDescription(lines.join('\n')).setColor(0x00FFFF)] });
    }

    if (commandName === 'giveaway') {
        return interaction.reply({ content: "🎉 Systems running processing protocols...", flags: [MessageFlags.Ephemeral] });
    }
});

client.login(process.env.BOT_TOKEN);
