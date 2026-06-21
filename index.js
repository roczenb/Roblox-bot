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
    AuditLogEvent,
    StringSelectMenuBuilder
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
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildVoiceStates
    ] 
});

const DB_FILE = './bot_data.json';
let data = { 
    users: {}, 
    groups: {}, 
    binds: {}, 
    antimention: {}, 
    protectedTargets: {},
    invites: {}, 
    logs: {},
    security: {},
    loggingChannels: {},
    xp: {},
    globalBlacklist: { users: [], servers: [] },
    shouts: {},
    tickets: {}
};

const LC_ROLE_NAME = "~{}~ Lead Command ~{}~"; 
const ANTIMENTION_BYPASS_ROLE = "Speaker of the Senate"; 

const cooldowns = new Map();
const guildInvitesCache = new Map();
const auditTracking = new Map();
const activeGiveaways = new Map();

function loadData() {
    try {
        if (fs.existsSync(DB_FILE)) {
            data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            if (!data.antimention) data.antimention = {};
            if (!data.protectedTargets) data.protectedTargets = {};
            if (!data.invites) data.invites = {};
            if (!data.logs) data.logs = {};
            if (!data.security) data.security = {};
            if (!data.loggingChannels) data.loggingChannels = {};
            if (!data.xp) data.xp = {};
            if (!data.globalBlacklist) data.globalBlacklist = { users: [], servers: [] };
            if (!data.shouts) data.shouts = {};
            if (!data.tickets) data.tickets = {};
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
    new SlashCommandBuilder().setName('version').setDescription('View the bot patch notes, version history, and creator metadata'),
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
    new SlashCommandBuilder().setName('logs-setup').setDescription('Admin Only: Setup output pipelines for logging operations')
        .addStringOption(o => o.setName('category').setDescription('The layout group target to bind').setRequired(true)
            .addChoices(
                { name: 'Join, Leave, Roles, Timeout, Kick & Ban Logs', value: 'joinLeave' },
                { name: 'Moderator Message Logs (Edit/Delete)', value: 'moderator' },
                { name: 'System Commands & Purges', value: 'system' }
            ))
        .addChannelOption(o => o.setName('target-channel').setDescription('The channel file system pointer destination').setRequired(true)),
    new SlashCommandBuilder().setName('purge').setDescription('Moderator Only: Bulk clear modern text parameters from this text channel')
        .addIntegerOption(o => o.setName('amount').setDescription('Target line threshold data range to eliminate (Max: 100)').setRequired(true)),
    
    // NEW EXTENDED ADVANCED FUNCTIONALITY COMMAND MODULES
    new SlashCommandBuilder().setName('rank-xp').setDescription('View your current server operational deployment experience level points').addUserOption(o => o.setName('target').setDescription('Target user profiling evaluation').setRequired(false)),
    new SlashCommandBuilder().setName('global-blacklist').setDescription('Roczenbeissel Exclusive: Manage structural master defense matrix parameters')
        .addStringOption(o => o.setName('action').setDescription('Select system execution target').setRequired(true).addChoices({ name: 'Add User', value: 'addUser' }, { name: 'Add Server', value: 'addServer' }, { name: 'Clear Profile', value: 'clear' }))
        .addStringOption(o => o.setName('id').setDescription('Target data payload string ID identification variable').setRequired(true)),
    new SlashCommandBuilder().setName('giveaway').setDescription('Initialize an advanced community reward distribution engine')
        .addStringOption(o => o.setName('prize').setDescription('What item/role is up for collection entry points').setRequired(true))
        .addIntegerOption(o => o.setName('duration').setDescription('Time threshold parameter duration in minutes').setRequired(true))
        .addIntegerOption(o => o.setName('winners').setDescription('Maximum allowed successful targets returned').setRequired(true))
        .addIntegerOption(o => o.setName('min-invites').setDescription('Gate parameter requiring minimum invite metrics').setRequired(false)),
    new SlashCommandBuilder().setName('tickets-setup').setDescription('Admin Only: Deploy an interactive multi-category ticket terminal dashboard pipeline'),
    new SlashCommandBuilder().setName('shout-bind-channel').setDescription('Admin Only: Bind the Roblox Group live feed shout mirror utility onto a text channel').addChannelOption(o => o.setName('target').setDescription('Target line pipeline tracking node destination').setRequired(true))
].map(c => c.toJSON());

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    for (const [guildId, guild] of client.guilds.cache) {
        if (data.globalBlacklist.servers.includes(guildId)) {
            console.log(`🚨 Auto-leaving blacklisted guild layout: ${guild.name} (${guildId})`);
            await guild.leave().catch(() => {});
            continue;
        }
        try {
            const firstInvites = await guild.invites.fetch();
            guildInvitesCache.set(guild.id, new Map(firstInvites.map(invite => [invite.code, invite.uses])));
        } catch (err) { console.log(`No invite permissions for guild: ${guildId}`); }
    }
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
        console.log('Started refreshing application (global) / commands...');
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('All slash commands are synced globally!');
    } catch (e) { console.error('Command registration failed:', e); }

    // INITIALIZE ROBLOX SHOUT AUTO-MIRROR FEED POLLING CYCLE ENGINE LOOP
    setInterval(pollRobloxShoutFeeds, 60000);
});

async function pollRobloxShoutFeeds() {
    for (const [guildId, groupId] of Object.entries(data.groups || {})) {
        const channelId = data.shouts?.[guildId];
        if (!channelId) continue;
        const targetGuild = client.guilds.cache.get(guildId);
        if (!targetGuild) continue;
        const targetChannel = targetGuild.channels.cache.get(channelId);
        if (!targetChannel) continue;

        try {
            const res = await axios.get(`https://groups.roproxy.com/v1/groups/${groupId}`);
            const shout = res.data.shout;
            if (!shout) continue;

            const previousShoutBody = data.shouts[`${guildId}-last`] || "";
            if (shout.body !== previousShoutBody) {
                data.shouts[`${guildId}-last`] = shout.body;
                saveData();

                const embed = new EmbedBuilder()
                    .setTitle("📢 New Roblox Group Transmission")
                    .setColor(0x00FFCC)
                    .setAuthor({ name: res.data.name, iconURL: `https://www.roblox.com/asset-thumbnail/image?assetId=${groupId}&width=150&height=150&format=png` })
                    .setDescription(shout.body)
                    .addFields({ name: "Posted By:", value: shout.poster.username, inline: true })
                    .setTimestamp(new Date(shout.updated));
                await targetChannel.send({ embeds: [embed] }).catch(() => {});
            }
        } catch (err) { console.error(`Error polling group ${groupId}:`, err.message); }
    }
}

function getLogChannel(guild, type) {
    const guildConfig = data.loggingChannels?.[guild.id];
    if (!guildConfig || !guildConfig[type]) return null;
    return guild.channels.cache.get(guildConfig[type]);
}

// --- PIPELINE 1: JOINS, LEAVES, ROLES, TIMEOUTS, KICKS & BANS ---
client.on('guildMemberAdd', async member => {
    if (data.globalBlacklist.users.includes(member.id)) {
        try {
            await member.send("🛑 Access Denied: You are globally blacklisted from utilizing software instances controlled by Roczenbeissel structural security parameters.");
            await member.ban({ reason: "Global Network Defense Matrix Blacklist Verification Match Trigger" });
            return;
        } catch (e) { console.error(e); }
    }

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

    const channel = getLogChannel(member.guild, 'joinLeave');
    if (channel) {
        const embed = new EmbedBuilder()
            .setTitle("📥 Member Joined")
            .setColor(0x2ECC71)
            .setThumbnail(member.user.displayAvatarURL())
            .addFields(
                { name: "User", value: `${member.user.tag} (<@${member.id}>)`, inline: true },
                { name: "Invite Used", value: inviteCodeUsed ? `\`${inviteCodeUsed}\`` : "Unknown/Vanity", inline: true },
                { name: "Inviter", value: usedBy !== "Unknown" ? `<@${usedBy}>` : "Unknown", inline: true }
            )
            .setTimestamp();
        channel.send({ embeds: [embed] }).catch(() => {});
    }
});

client.on('guildCreate', async guild => {
    if (data.globalBlacklist.servers.includes(guild.id)) {
        console.log(`🚨 Joined blacklisted guild. Leaving: ${guild.name}`);
        await guild.leave().catch(() => {});
    }
});

client.on('guildMemberRemove', async member => {
    const log = data.logs[member.id];
    if (log && data.invites[member.guild.id]?.[log.inviter]) {
        data.invites[member.guild.id][log.inviter].left += 1;
        saveData();
    }

    const channel = getLogChannel(member.guild, 'joinLeave');
    if (channel) {
        setTimeout(async () => {
            const auditLogs = await member.guild.fetchAuditLogs({ limit: 1 }).catch(() => null);
            const kickLog = auditLogs?.entries.first();
            const isKick = kickLog && kickLog.action === AuditLogEvent.MemberKick && kickLog.target.id === member.id && (Date.now() - kickLog.createdTimestamp < 10000);

            if (isKick) {
                const embed = new EmbedBuilder()
                    .setTitle("👢 Member Kicked")
                    .setColor(0xE67E22)
                    .addFields(
                        { name: "Target Member", value: `${member.user.tag} (${member.id})` },
                        { name: "Executed By", value: `<@${kickLog.executor.id}>` },
                        { name: "Reason", value: kickLog.reason || "No explicit reason specified." }
                    )
                    .setTimestamp();
                return channel.send({ embeds: [embed] }).catch(() => {});
            }

            const embed = new EmbedBuilder()
                .setTitle("📤 Member Left")
                .setColor(0x95A5A6)
                .addFields({ name: "User Identity", value: `${member.user.tag} (<@${member.id}>)` })
                .setTimestamp();
            channel.send({ embeds: [embed] }).catch(() => {});
        }, 2000);
    }
});

client.on('guildBanAdd', async ban => {
    const channel = getLogChannel(ban.guild, 'joinLeave');
    if (channel) {
        const auditLogs = await ban.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.MemberBanAdd }).catch(() => null);
        const banLog = auditLogs?.entries.first();
        
        const embed = new EmbedBuilder()
            .setTitle("🚨 Member Banned")
            .setColor(0xE74C3C)
            .addFields(
                { name: "User Profile Target", value: `${ban.user.tag} (${ban.user.id})` },
                { name: "Moderator Processing", value: banLog ? `<@${banLog.executor.id}>` : "Unknown" },
                { name: "Reason", value: ban.reason || "No structural reason designated." }
            )
            .setTimestamp();
        channel.send({ embeds: [embed] }).catch(() => {});
    }
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
    const channel = getLogChannel(newMember.guild, 'joinLeave');
    if (!channel) return;

    const oldTimeout = oldMember.communicationDisabledUntilTimestamp;
    const newTimeout = newMember.communicationDisabledUntilTimestamp;

    if (oldTimeout !== newTimeout) {
        if (newTimeout && newTimeout > Date.now()) {
            const durationMs = newTimeout - Date.now();
            const durationMins = Math.round(durationMs / 60000);
            
            const embed = new EmbedBuilder()
                .setTitle("⏳ Member Timed Out")
                .setColor(0xE67E22)
                .addFields(
                    { name: "Target User", value: `${newMember.user.tag} (<@${newMember.id}>)` },
                    { name: "Duration", value: `\`${durationMins} minutes\`` }
                )
                .setTimestamp();
            channel.send({ embeds: [embed] }).catch(() => {});
        } else if (oldTimeout && !newTimeout) {
            const embed = new EmbedBuilder()
                .setTitle("🔊 Timeout Removed")
                .setColor(0x2ECC71)
                .addFields({ name: "Target User", value: `${newMember.user.tag} (<@${newMember.id}>)` })
                .setTimestamp();
            channel.send({ embeds: [embed] }).catch(() => {});
        }
    }

    const addedRoles = newMember.roles.cache.filter(role => !oldMember.roles.cache.has(role.id));
    const removedRoles = oldMember.roles.cache.filter(role => !newMember.roles.cache.has(role.id));

    if (addedRoles.size > 0 || removedRoles.size > 0) {
        const embed = new EmbedBuilder()
            .setTitle("🛡️ Member Roles Updated")
            .setColor(0x3498DB)
            .setDescription(`Modified variables found for tracking target: <@${newMember.id}>`)
            .setTimestamp();

        if (addedRoles.size > 0) {
            embed.addFields({ name: "Roles Assigned", value: addedRoles.map(r => `<@&${r.id}>`).join(', ') });
        }
        if (removedRoles.size > 0) {
            embed.addFields({ name: "Roles Revoked", value: removedRoles.map(r => `<@&${r.id}>`).join(', ') });
        }
        channel.send({ embeds: [embed] }).catch(() => {});
    }
});

// --- PIPELINE 2: CHAT CONTEXT MODERATOR PROTECTION (EDIT/DELETE) ---
client.on('messageDelete', async message => {
    if (!message.guild || message.author?.bot) return;
    const channel = getLogChannel(message.guild, 'moderator');
    if (!channel) return;

    const embed = new EmbedBuilder()
        .setTitle("🗑️ Message Deleted")
        .setColor(0xE74C3C)
        .addFields(
            { name: "Author Profile", value: `<@${message.author.id}> (${message.author.tag})`, inline: true },
            { name: "Channel Location", value: `<#${message.channel.id}>`, inline: true },
            { name: "Raw Content Destroyed", value: message.content || "*[No structural content layout captured]*" }
        )
        .setTimestamp();
    channel.send({ embeds: [embed] }).catch(() => {});
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
    if (!oldMessage.guild || oldMessage.author?.bot || oldMessage.content === newMessage.content) return;
    const channel = getLogChannel(oldMessage.guild, 'moderator');
    if (!channel) return;

    const embed = new EmbedBuilder()
        .setTitle("📝 Message Edited")
        .setColor(0xF1C40F)
        .addFields(
            { name: "Author Profile", value: `<@${oldMessage.author.id}>`, inline: true },
            { name: "Channel Location", value: `<#${oldMessage.channel.id}>`, inline: true },
            { name: "Original Context String", value: oldMessage.content || "*Empty String*" },
            { name: "Revised Context String", value: newMessage.content || "*Empty String*" }
        )
        .setTimestamp();
    channel.send({ embeds: [embed] }).catch(() => {});
});

// --- PIPELINE 3: SERVER STRUCTURE MANAGEMENT UPDATES ---
function logSystemAction(guild, title, fields) {
    const channel = getLogChannel(guild, 'system');
    if (!channel) return;
    const embed = new EmbedBuilder().setTitle(title).setColor(0x9B59B6).setTimestamp();
    if (fields && fields.length) embed.addFields(fields);
    channel.send({ embeds: [embed] }).catch(() => {});
}

client.on('channelCreate', channel => {
    if (channel.guild) logSystemAction(channel.guild, "🆕 Channel Created", [{ name: "Channel Details", value: `${channel.name} (<#${channel.id}>)` }]);
});

client.on('channelDelete', channel => {
    if (channel.guild) {
        incrementSecurityTrigger(channel.guild.id);
        logSystemAction(channel.guild, "❌ Channel Removed", [{ name: "Channel Name Trace", value: `\`${channel.name}\` (${channel.id})` }]);
    }
});

client.on('channelUpdate', (oldChannel, newChannel) => {
    if (!newChannel.guild) return;
    let changes = [];
    if (oldChannel.name !== newChannel.name) changes.push({ name: "Name Renamed", value: `\`${oldChannel.name}\` ➡️ \`${newChannel.name}\`` });
    if (oldChannel.topic !== newChannel.topic) changes.push({ name: "Topic Updated", value: `Before: *${oldChannel.topic || "None"}*\nAfter: *${newChannel.topic || "None"}*` });
    
    if (changes.length > 0) {
        logSystemAction(newChannel.guild, "⚙️ Channel Structural Modification Update", [
            { name: "Channel Target Profile", value: `<#${newChannel.id}>` },
            ...changes
        ]);
    }
});

// --- AUTOMATED CHAT MONITORING ENGINE ---
client.on('inviteCreate', invite => {
    const cache = guildInvitesCache.get(invite.guild.id);
    if (cache) cache.set(invite.code, invite.uses);
});

client.on('messageCreate', async message => {
    if (!message.guild || message.author.bot) return;

    // INTERACTIVE LIVE PROGRESSION SYSTEM (XP ACCUMULATION ENGINE)
    if (!data.xp[message.guild.id]) data.xp[message.guild.id] = {};
    if (!data.xp[message.guild.id][message.author.id]) {
        data.xp[message.guild.id][message.author.id] = { xp: 0, level: 0 };
    }
    
    let userXpProfile = data.xp[message.guild.id][message.author.id];
    userXpProfile.xp += Math.floor(Math.random() * 6) + 10;
    let nextLevelThresh = (userXpProfile.level + 1) * 350;
    
    if (userXpProfile.xp >= nextLevelThresh) {
        userXpProfile.level += 1;
        saveData();
        const upEmbed = new EmbedBuilder()
            .setTitle("🎖️ Military Activity Promotion")
            .setColor(0xF1C40F)
            .setDescription(`Congratulations <@${message.author.id}>, you have achieved deployment status milestone **Level ${userXpProfile.level}** through operational activity metric tracking!`);
        message.channel.send({ embeds: [upEmbed] }).then(m => setTimeout(() => m.delete().catch(() => {}), 10000));
    } else {
        saveData();
    }

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
            const warning = await message.channel.send(`⚠️ <@${message.author.id}>, ${protectionReason}.`);
            setTimeout(() => warning.delete().catch(() => {}), 5000);
        } catch (err) { console.log(err.message); }
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
        const channel = client.guilds.cache.get(guildId).channels.cache.find(c => c.isTextBased());
        if (channel) {
            channel.send(`🚨 **SECURITY ALERT:** Rapid structural deletions detected (${dynamicFilter.length}/${criticalThreshold})! **BEAST MODE ENABLED.** Invites are paused, and entry points are locked down.`);
        }
    }
}

client.on('roleDelete', role => { if (role.guild) incrementSecurityTrigger(role.guild.id); });

async function applyUserRankMutations(member, robloxId, bindConfig, username) {
    if (bindConfig.nicknameFormat) {
        let structuredName = bindConfig.nicknameFormat.replace('{roblox_username}', username);
        if (structuredName.length <= 32) {
            await member.setNickname(structuredName).catch(() => {});
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
    } catch (e) { return interaction.editReply(`❌ Error: ${e.message}`); }
}

async function runUpdateProcess(interaction, targetUser) {
    const isTargetingOther = targetUser.id !== interaction.user.id;
    const robloxId = data.users[targetUser.id];
    if (!robloxId) return interaction.editReply(isTargetingOther ? `❌ That user has not run \`/verify\` yet.` : "❌ You need to connect your profile first.");
    
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
            .addFields(
                { name: "User:", value: `<@${targetUser.id}>`, inline: false },
                { name: "Roles Added", value: added.length > 0 ? added.join('\n') : "No new ranks to add.", inline: false }
            );
        return interaction.editReply({ embeds: [embed] });
    } catch (e) { return interaction.editReply("❌ Update network error."); }
}

client.on('interactionCreate', async interaction => {
    // RESOLVE INTERACTIVE SYSTEM BACKEND BUTTON AND DROPDOWN PIPELINES
    if (interaction.isButton()) {
        const { customId, guild, member, user } = interaction;
        
        if (customId === 'panel_link_btn') {
            return interaction.reply({ content: "Please run the modern slash platform utility: `/verify [your_roblox_username]` directly in line text chat.", flags: [MessageFlags.Ephemeral] });
        }
        if (customId === 'panel_update_btn') {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            return await runUpdateProcess(interaction, user);
        }
        
        // GIVEAWAY ENGINE INTERACTION ROUTER ENTRY PACKET
        if (customId.startsWith('giveaway_join_')) {
            const gId = customId.replace('giveaway_join_', '');
            const giveaway = activeGiveaways.get(gId);
            if (!giveaway) return interaction.reply({ content: "❌ This community reward matrix distribution context has already terminated.", flags: [MessageFlags.Ephemeral] });
            
            if (giveaway.minInvites > 0) {
                const userInvs = data.invites[guild.id]?.[user.id] || { regular: 0, left: 0 };
                const net = userInvs.regular - userInvs.left;
                if (net < giveaway.minInvites) {
                    return interaction.reply({ content: `❌ Requirement mismatch: This giveaway requires structural proof of at least **${giveaway.minInvites} validation invites**. You possess \`${net}\`.`, flags: [MessageFlags.Ephemeral] });
                }
            }
            if (giveaway.participants.includes(user.id)) {
                return interaction.reply({ content: "ℹ️ Your profile trace is already documented inside this entry collection container.", flags: [MessageFlags.Ephemeral] });
            }
            giveaway.participants.push(user.id);
            return interaction.reply({ content: "🎉 Entry sequence logged successfully! Best of luck in the random raffle pool draws.", flags: [MessageFlags.Ephemeral] });
        }

        // TICKET CLOSE OPERATION ACTION ROUTER
        if (customId === 'close_ticket_btn') {
            await interaction.reply("🔒 Archiving channel stream pipelines and capturing database thread history...");
            const messages = await interaction.channel.messages.fetch({ limit: 100 });
            let transcript = messages.reverse().map(m => `[${m.createdAt.toISOString()}] ${m.author.tag}: ${m.content}`).join('\n');
            
            const logChannel = getLogChannel(guild, 'system');
            if (logChannel) {
                const file = Buffer.from(transcript, 'utf-8');
                await logChannel.send({ content: `🎟️ **Ticket Thread Archived:** File history logged for ticket channel reference context \`${interaction.channel.name}\`.`, files: [{ attachment: file, name: `${interaction.channel.name}-archive.txt` }] });
            }
            setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
            return;
        }
    }

    if (interaction.isStringSelectMenu()) {
        const { customId, values, guild, member, user } = interaction;
        if (customId === 'ticket_category_select') {
            const chosenType = values[0];
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            
            const channelTicket = await guild.channels.create({
                name: `ticket-${chosenType}-${user.username.slice(0,4)}`,
                type: ChannelType.GuildText,
                permissionOverwrites: [
                    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
                ]
            });

            const tEmbed = new EmbedBuilder()
                .setTitle(`🎫 Private Support Ticket Opened`)
                .setColor(0xE67E22)
                .setDescription(`Greetings <@${user.id}>. This private channel pipeline has been configured to process variables aligned with **${chosenType.toUpperCase()}** tracking.\nOur active support staff has been alerted.`)
                .setTimestamp();
                
            const closeRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('close_ticket_btn').setLabel('Close File Pipeline').setStyle(ButtonStyle.Danger)
            );

            await channelTicket.send({ embeds: [tEmbed], components: [closeRow] });
            return interaction.editReply(`✅ Ticket channel generated successfully. Redirect destination link coordinates: <#${channelTicket.id}>`);
        }
    }

    if (!interaction.isChatInputCommand()) return;
    const { commandName, options, guildId, member, channel, guild } = interaction;

    if (commandName === 'version') {
        const versionEmbed = new EmbedBuilder()
            .setTitle("⚙️ Bot Version & System History")
            .setColor(0x3498DB)
            .setThumbnail(client.user.displayAvatarURL())
            .setDescription("Detailed software metadata parameters and recent build adjustments.")
            .addFields(
                { name: "👑 Bot Creator / Owner", value: "**Roczenbeissel**", inline: true },
                { name: "📦 Software Version", value: "`v3.0.0-Elite-Beast`", inline: true },
                { name: "🟢 Library Environment", value: `\`discord.js v14\``, inline: true },
                { name: "📅 Last Production Update", value: `<t:1781992336:F>`, inline: false },
                { name: "🛠️ Advanced Feature Patch Updates", value: 
                    "• Integrated dynamic user background chat network leveling metrics (XP System).\n" +
                    "• Built complete dynamic select-menu multi-category Support Ticket Engines.\n" +
                    "• Programmed requirement-gated server Giveaway processing loops with database sync arrays.\n" +
                    "• Enabled Roczenbeissel exclusive central network Global Blacklist tracking overrides.\n" +
                    "• Activated background Roblox Group live feed shout mirroring systems using automated polling hooks." 
                }
            )
            .setFooter({ text: `System Mainframe Operational Status: Optimal`, iconURL: client.user.displayAvatarURL() })
            .setTimestamp();

        return interaction.reply({ embeds: [versionEmbed] });
    }

    if (commandName === 'global-blacklist') {
        if (interaction.user.username !== 'roczenbeissel' && interaction.user.id !== '338427976192229377') { // Security safety locks
            return interaction.reply({ content: "❌ Structural Constraint Violation: This command configuration is strictly hardcoded to the master developer signature of Roczenbeissel.", flags: [MessageFlags.Ephemeral] });
        }
        const action = options.getString('action');
        const targetId = options.getString('id');

        if (action === 'addUser') {
            data.globalBlacklist.users.push(targetId);
            saveData();
            return interaction.reply(`🚨 **Global Security Lock:** Target User ID \`${targetId}\` added to system ban matrices.`);
        } else if (action === 'addServer') {
            data.globalBlacklist.servers.push(targetId);
            saveData();
            const badGuild = client.guilds.cache.get(targetId);
            if (badGuild) await badGuild.leave().catch(() => {});
            return interaction.reply(`🚨 **Global Security Lock:** Target Guild ID \`${targetId}\` blacklisted. Instigating auto-severance procedures.`);
        } else {
            data.globalBlacklist = { users: [], servers: [] };
            saveData();
            return interaction.reply("✅ Global blacklists reset.");
        }
    }

    if (commandName === 'rank-xp') {
        const target = options.getUser('target') || interaction.user;
        const profile = data.xp?.[guildId]?.[target.id] || { xp: 0, level: 0 };
        const nextLevelThresh = (profile.level + 1) * 350;

        const embed = new EmbedBuilder()
            .setTitle(`🎖️ Deployment Status Evaluation`)
            .setColor(0x3498DB)
            .addFields(
                { name: "Target Soldier", value: `<@${target.id}>`, inline: true },
                { name: "Current Level", value: `\`Level ${profile.level}\``, inline: true },
                { name: "Experience points", value: `\`${profile.xp} / ${nextLevelThresh} XP\``, inline: false }
            );
        return interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'shout-bind-channel') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply("❌ Access Denied.");
        const targetChannel = options.getChannel('target');
        if (!data.shouts) data.shouts = {};
        data.shouts[guildId] = targetChannel.id;
        saveData();
        return interaction.reply(`✅ Successfully mapped the Roblox live shout mirror transmission channel onto <#${targetChannel.id}>.`);
    }

    if (commandName === 'giveaway') {
        if (!member.permissions.has(PermissionFlagsBits.ManageMessages)) return interaction.reply("❌ Access Denied.");
        const prize = options.getString('prize');
        const duration = options.getInteger('duration');
        const winnersCount = options.getInteger('winners');
        const minInvites = options.getInteger('min-invites') || 0;

        await interaction.reply("🎁 Initializing giveaway network context containers...");
        const gId = interaction.id;
        const giveawayConfig = { prize, winnersCount, minInvites, participants: [], channelId: channel.id };
        activeGiveaways.set(gId, giveawayConfig);

        const embed = new EmbedBuilder()
            .setTitle("🎉 COMMUNITY REWARD DISTRIBUTION RATTLE 🎉")
            .setColor(0xEE82EE)
            .setDescription(`A reward distribution container has been loaded for **${prize}**!`)
            .addFields(
                { name: "Time Window Close:", value: `<t:${Math.floor((Date.now() + (duration * 60000)) / 1000)}:R>`, inline: true },
                { name: "Winner Limit Targets:", value: `\`${winnersCount}\``, inline: true },
                { name: "Invite Entry Restrictions:", value: minInvites > 0 ? `\`Requires minimum ${minInvites} invites\`` : "`None`", inline: false }
            );

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`giveaway_join_${gId}`).setLabel('Enter Draw').setStyle(ButtonStyle.Primary).setEmoji('🎟️')
        );

        const msg = await channel.send({ embeds: [embed], components: [row] });

        setTimeout(async () => {
            const activeObj = activeGiveaways.get(gId);
            activeGiveaways.delete(gId);
            if (!activeObj || !activeObj.participants.length) {
                return channel.send(`🛑 **Giveaway Cancelled:** There were insufficient entry tracking fields logged for reward draw processing of **${prize}**.`);
            }

            let pool = activeObj.participants;
            let chosenWinners = [];
            for (let i = 0; i < Math.min(activeObj.winnersCount, pool.length); i++) {
                let index = Math.floor(Math.random() * pool.length);
                chosenWinners.push(`<@${pool[index]}>`);
                pool.splice(index, 1);
            }

            await msg.edit({ components: [] }).catch(() => {});
            return channel.send(`🎉 **GIVEAWAY COMPLETE:** Congratulations to ${chosenWinners.join(', ')}! You won the community drawing for **${prize}**!`);
        }, duration * 60000);
        return;
    }

    if (commandName === 'tickets-setup') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply("❌ Access Denied.");
        const tEmbed = new EmbedBuilder()
            .setTitle("📋 Military Support Request Interface Hub")
            .setColor(0x2C3E50)
            .setDescription("Need support infrastructure or high-ranking clearance oversight? Select an active categorical support ticket profile array down below to deploy a secure private text connection pipeline thread channel.");

        const menu = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('ticket_category_select')
                .setPlaceholder('Establish communication file pipeline...')
                .addOptions(
                    { label: 'Rank Transfer Clearance Request', value: 'rank_transfer', description: 'Request rank updates aligned with cross-server migration metrics.' },
                    { label: 'Report Malicious Activities', value: 'abuse_report', description: 'Flag a specific target matching parameters of treason or structural exploitation.' },
                    { label: 'General Division Questions', value: 'general_help', description: 'Acquire feedback relating to server organizational parameters.' }
                )
        );

        await channel.send({ embeds: [tEmbed], components: [menu] });
        return interaction.reply({ content: "Operational configuration dashboard successfully anchored to visual channel metrics.", flags: [MessageFlags.Ephemeral] });
    }

    if (commandName === 'logs-setup') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        const category = options.getString('category');
        const targetChannel = options.getChannel('target-channel');

        if (!data.loggingChannels) data.loggingChannels = {};
        if (!data.loggingChannels[guildId]) data.loggingChannels[guildId] = { joinLeave: null, moderator: null, system: null };

        data.loggingChannels[guildId][category] = targetChannel.id;
        saveData();

        return interaction.reply(`✅ Successfully mapped log profile category **${category}** to channel context pipeline <#${targetChannel.id}>.`);
    }

    if (commandName === 'purge') {
        if (!member.permissions.has(PermissionFlagsBits.ManageMessages)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        const amount = options.getInteger('amount');
        if (amount < 1 || amount > 100) return interaction.reply({ content: "❌ Value configuration constraint violation. Select a threshold from 1 to 100.", flags: [MessageFlags.Ephemeral] });

        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        try {
            const deleted = await channel.bulkDelete(amount, true);
            interaction.editReply(`🧹 Complete. Cleaned up \`${deleted.size}\` messages from the display screen.`);
            
            logSystemAction(guild, "🧹 Channel Purged Execution", [
                { name: "Moderator Processing", value: `<@${interaction.user.id}>`, inline: true },
                { name: "Channel Location", value: `<#${channel.id}>`, inline: true },
                { name: "Line Total Purged", value: `\`${deleted.size}\` entries`, inline: true }
            ]);
        } catch (err) {
            interaction.editReply(`❌ Data deletion network error: ${err.message}`);
        }
        return;
    }

    if (commandName === 'security-config') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply("❌ Access Denied.");
        const activeSetting = options.getBoolean('active');
        const customThreshold = options.getInteger('beast-threshold');
        const finalLimit = customThreshold !== null ? customThreshold : (data.security[guildId]?.limit || 4);

        if (finalLimit < 1) return interaction.reply({ content: "❌ Limit must be 1 or higher.", flags: [MessageFlags.Ephemeral] });
        data.security[guildId] = { enabled: activeSetting, beastMode: data.security[guildId]?.beastMode || false, limit: finalLimit };
        saveData();
        return interaction.reply(`🛡️ **Security Protocol Saved:**\n• Active: **${activeSetting}**\n• Limit Threshold: **${finalLimit} modifications**`);
    }

    if (commandName === 'beast-disable') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply("❌ Access Denied.");
        if (data.security[guildId]) data.security[guildId].beastMode = false;
        saveData();
        return interaction.reply("✅ **BEAST MODE DEACTIVATED.**");
    }

    if (commandName === 'verify') {
        const wait = checkCooldown(interaction.user.id, commandName, 5);
        if (wait) return interaction.reply({ content: `⏳ Cooldown active: ${wait}s`, flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        return await runVerificationProcess(interaction, options.getString('username'));
    }

    if (commandName === 'invites-leaderboard') {
        await interaction.deferReply();
        const serverInvs = data.invites[guildId] || {};
        
        const sorted = Object.entries(serverInvs)
            .map(([id, val]) => ({
                id,
                regular: val.regular || 0,
                left: val.left || 0,
                fake: val.fake || 0,
                bonus: val.bonus || 0,
                total: (val.regular || 0) - (val.left || 0) + (val.bonus || 0)
            }))
            .sort((a, b) => b.total - a.total)
            .slice(0, 10);

        if (!sorted.length) return interaction.editReply("No profile invite fields parsed yet.");

        let descriptionLines = sorted.map((u, i) => {
            return `${i + 1}. <@${u.id}> • **${u.total}** invites. (${u.regular} regular, ${u.left} left, ${u.fake} fake, ${u.bonus} bonus)`;
        });

        const leaderboardEmbed = new EmbedBuilder()
            .setTitle("Invites Leaderboard")
            .setColor(0x00FFFF)
            .setDescription(descriptionLines.join('\n'));

        return interaction.editReply({ embeds: [leaderboardEmbed] });
    }

    if (commandName === 'setup-group') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply("❌ Access Denied.");
        await interaction.deferReply();
        if (!data.groups) data.groups = {};
        data.groups[guildId] = options.getString('groupid');
        saveData();
        return interaction.editReply("✅ Group linked successfully.");
    }

    if (commandName === 'sync-group-roles') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply("❌ Access Denied.");
        await interaction.deferReply();
        const gId = data.groups ? data.groups[guildId] : null;
        if (!gId) return interaction.editReply("❌ Run /setup-group first.");
        try {
            const rRoles = (await axios.get(`https://groups.roproxy.com/v1/groups/${gId}/roles`)).data.roles
                .filter(r => r.rank > 0).sort((a, b) => a.rank - b.rank);

            if (!data.binds[guildId]) data.binds[guildId] = [];
            const existingRoles = await interaction.guild.roles.fetch();

            for (const r of rRoles) {
                data.binds[guildId] = data.binds[guildId].filter(b => !(b.groupId === gId && b.rankId === r.rank));
                let existingRole = existingRoles.find(role => role.name === r.name);
                if (!existingRole) {
                    existingRole = await interaction.guild.roles.create({ name: r.name, reason: 'Auto-sync' });
                }
                data.binds[guildId].push({ groupId: gId, rankId: r.rank, roleId: existingRole.id, nicknameFormat: null, minInvites: 0 });
            }
            saveData();
            return interaction.editReply(`🎉 **Sync complete!** Chains arranged successfully.`);
        } catch (e) { return interaction.editReply(`❌ Sync fail: ${e.message}`); }
    }

    if (commandName === 'view-binds') {
        await interaction.deferReply();
        const serverBinds = data.binds ? data.binds[guildId] : [];
        if (!serverBinds.length) return interaction.editReply("❌ No active role links configured.");
        let bindList = serverBinds.map(b => `• **Rank ${b.rankId}** → <@&${b.roleId}>`);
        return interaction.editReply({ embeds: [new EmbedBuilder().setTitle("Active Configurations").setDescription(bindList.join('\n'))] });
    }

    if (commandName === 'update') {
        await interaction.deferReply();
        return await runUpdateProcess(interaction, options.getUser('user') || interaction.user);
    }

    if (commandName === 'ban') {
        if (!member.permissions.has(PermissionFlagsBits.BanMembers)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.guild.members.ban(options.getUser('target'));
        return interaction.reply("🚨 Account banned.");
    }

    if (commandName === 'unban') {
        if (!member.permissions.has(PermissionFlagsBits.BanMembers)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        const userIdInput = options.getString('userid');
        try {
            await interaction.guild.members.unban(userIdInput);
            return interaction.reply(`✅ Successfully unbanned user ID: \`${userIdInput}\``);
        } catch (err) {
            return interaction.reply({ content: `❌ Failed to unban user. Ensure the ID is valid and they are banned. Error: ${err.message}`, flags: [MessageFlags.Ephemeral] });
        }
    }
    
    if (commandName === 'kick') {
        if (!member.permissions.has(PermissionFlagsBits.KickMembers)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await options.getMember('target').kick();
        return interaction.reply("👢 Member kicked.");
    }

    if (commandName === 'timeout') {
        if (!member.permissions.has(PermissionFlagsBits.ModerateMembers)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await options.getMember('target').timeout(options.getInteger('minutes') * 60 * 1000);
        return interaction.reply("⏳ Member isolated.");
    }

    if (commandName === 'unmute') {
        if (!member.permissions.has(PermissionFlagsBits.ModerateMembers)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        const targetMember = options.getMember('target');
        if (!targetMember) return interaction.reply({ content: "❌ Target member not found in this guild.", flags: [MessageFlags.Ephemeral] });
        try {
            await targetMember.timeout(null);
            return interaction.reply(`🔊 Active timeout has been lifted from <@${targetMember.id}>.`);
        } catch (err) {
            return interaction.reply({ content: `❌ Failed to remove timeout: ${err.message}`, flags: [MessageFlags.Ephemeral] });
        }
    }

    if (commandName === 'say') {
        if (!member.permissions.has(PermissionFlagsBits.ManageMessages)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await channel.send(options.getString('text'));
        return interaction.reply({ content: "Broadcast sent.", flags: [MessageFlags.Ephemeral] });
    }

    if (commandName === 'verification-panel') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply("❌ Access Denied.");
        const panelEmbed = new EmbedBuilder().setTitle("Link Account").setDescription("Click **Link** below to hook your profile up.").setColor(0x355eed);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('panel_link_btn').setLabel('Link Roblox').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('panel_update_btn').setLabel('Update').setStyle(ButtonStyle.Secondary)
        );
        await channel.send({ embeds: [panelEmbed], components: [row] });
        return interaction.reply({ content: "Deployed.", flags: [MessageFlags.Ephemeral] });
    }
});

client.login(process.env.BOT_TOKEN);
