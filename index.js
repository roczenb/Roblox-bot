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
    logsChannels: { system: null, moderator: null, movement: null },
    verifiedRoleId: {}, 
    unverifiedRoleId: {},
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
            if (!data.verifiedRoleId) data.verifiedRoleId = {};
            if (!data.unverifiedRoleId) data.unverifiedRoleId = {};
            if (!data.ticketCounter) data.ticketCounter = {};
        }
    } catch (e) { console.log("Data loaded smoothly."); }
}

function saveData() {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); } catch (e) { console.error(e); }
}

loadData();

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
    
    new SlashCommandBuilder().setName('sync-group-roles').setDescription('Auto-bind an entire group structure by chain of command')
        .addStringOption(o => o.setName('groupid').setDescription('Roblox Group ID to completely map out').setRequired(true)),
    
    new SlashCommandBuilder().setName('bind').setDescription('Bind a specific rank to a role')
        .addStringOption(o => o.setName('groupid').setDescription('Roblox Group ID').setRequired(true))
        .addIntegerOption(o => o.setName('rankid').setDescription('Rank ID (0-255)').setRequired(true))
        .addRoleOption(o => o.setName('role').setDescription('Discord Role Target').setRequired(true))
        .addStringOption(o => o.setName('nickname-format').setDescription('Format, e.g: E1 | {roblox_username}').setRequired(false))
        .addIntegerOption(o => o.setName('min-invites').setDescription('Minimum required invites').setRequired(false)),
    
    new SlashCommandBuilder().setName('update').setDescription('Sync ranks in this server').addUserOption(o => o.setName('user').setDescription('Admin Only: Target user to update').setRequired(false)),
    new SlashCommandBuilder().setName('sync-milestones').setDescription('Admin Only: Force tier updates').addUserOption(o => o.setName('target').setDescription('The trooper to sync tier roles for').setRequired(true)),
    
    new SlashCommandBuilder().setName('setup-milestones').setDescription('Admin Only: Configure roles awarded at/above a Roblox rank')
        .addStringOption(o => o.setName('groupid').setDescription('Roblox Group ID to evaluate against').setRequired(true))
        .addStringOption(o => o.setName('category-name').setDescription('Label for this pool (e.g. Officer Pack)').setRequired(true))
        .addStringOption(o => o.setName('roles-list').setDescription('Comma separated list of multiple roles (e.g. @Role1, @Role2)').setRequired(true))
        .addIntegerOption(o => o.setName('min-rank').setDescription('The minimum Roblox rank number required').setRequired(true)),
    
    new SlashCommandBuilder().setName('setup-logs').setDescription('Admin Only: Route logs to independent tracking stations')
        .addStringOption(o => o.setName('category').setDescription('Select targeting track pipeline category').setRequired(true)
            .addChoices(
                { name: 'System Logs (Purge, Kick, Ban, Timeouts, Server/Channel Changes)', value: 'system' },
                { name: 'Moderator Logs (Message Edits, Message Deletions)', value: 'moderator' },
                { name: 'Join-Leave Logs (Joins, Leaves, Role Updates)', value: 'movement' }
            ))
        .addChannelOption(o => o.setName('channel').setDescription('Target stream destination channel text frame').setRequired(true)),

    new SlashCommandBuilder().setName('setup-verified-role').setDescription('Admin Only: Set the role automatically awarded upon successful verification')
        .addRoleOption(o => o.setName('role').setDescription('The Discord role to assign').setRequired(true)),

    new SlashCommandBuilder().setName('setup-unverified-role').setDescription('Admin Only: Set the role automatically awarded to unverified users')
        .addRoleOption(o => o.setName('role').setDescription('The Discord role to assign').setRequired(true)),

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
    new SlashCommandBuilder().setName('purge').setDescription('Admin Only: Delete bulk message packets')
        .addIntegerOption(o => o.setName('amount').setDescription('Number of messages to clear').setRequired(true))
].map(c => c.toJSON());

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    for (const [guildId, guild] of client.guilds.cache) {
        try {
            const firstInvites = await guild.invites.fetch();
            guildInvitesCache.set(guild.id, new Map(firstInvites.map(invite => [invite.code, invite.uses])));
        } catch (err) { console.log(`Invite monitoring caching skipped.`); }
    }
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
        await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
        const guilds = await client.guilds.fetch();
        for (const [guildId] of guilds) {
            await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
        }
        console.log('Bot fully loaded with dynamic text prefix commands and slash functionality.');
    } catch (e) { console.error(e); }
});

client.on('inviteCreate', invite => {
    const cache = guildInvitesCache.get(invite.guild.id);
    if (cache) cache.set(invite.code, invite.uses);
});

client.on('guildMemberAdd', async member => {
    if (data.security[member.guild.id]?.beastMode) {
        try {
            await member.send("⚠️ This server is under high security lockdown.");
            await member.kick("Beast Mode Activity Mitigation");
            dispatchLog(member.guild.id, 'system', `🚨 **Beast Mode Security Tripped:** Kicked incoming user <@${member.id}>`);
            return;
        } catch (e) { console.error(e); }
    }

    // Auto assign unverified role if mapped out
    const activeUnverifiedId = data.unverifiedRoleId?.[member.guild.id];
    if (activeUnverifiedId) {
        const targetUnvRole = member.guild.roles.cache.get(activeUnverifiedId);
        if (targetUnvRole) await member.roles.add(targetUnvRole).catch(() => {});
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
        .setDescription(`<@${member.id}> joined.\n**Invited By:** <@${usedBy}>\n**Code:** \`${inviteCodeUsed || 'N/A'}\``)
        .setTimestamp();
    dispatchLog(member.guild.id, 'movement', { embeds: [joinEmbed] });
});

client.on('guildMemberRemove', async member => {
    const log = data.logs[member.id];
    let inviterString = "Unknown Recruiter";
    if (log && data.invites[member.guild.id]?.[log.inviter]) {
        data.invites[member.guild.id][log.inviter].left += 1;
        saveData();
        inviterString = `<@${log.inviter}>`;
    }

    const leaveEmbed = new EmbedBuilder()
        .setTitle("📤 Member Severed Connection")
        .setColor(0xE74C3C)
        .setDescription(`<@${member.id}> left.\n**Original Recruiter:** ${inviterString}`)
        .setTimestamp();
    dispatchLog(member.guild.id, 'movement', { embeds: [leaveEmbed] });
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
    const oldRoles = oldMember.roles.cache;
    const newRoles = newMember.roles.cache;

    if (oldRoles.size !== newRoles.size) {
        const addedRoles = newRoles.filter(role => !oldRoles.has(role.id));
        const removedRoles = oldRoles.filter(role => !newRoles.has(role.id));

        const updateEmbed = new EmbedBuilder()
            .setTitle("🛡️ Member Role Modification")
            .setColor(0x9B59B6)
            .setAuthor({ name: newMember.user.tag, iconURL: newMember.user.displayAvatarURL() })
            .setDescription(`**Target Account:** <@${newMember.id}>`)
            .setTimestamp();

        if (addedRoles.size > 0) updateEmbed.addFields({ name: "➕ Granted Role:", value: addedRoles.map(r => `<@&${r.id}>`).join(', ') });
        if (removedRoles.size > 0) updateEmbed.addFields({ name: "➖ Revoked Role:", value: removedRoles.map(r => `<@&${r.id}>`).join(', ') });

        dispatchLog(newMember.guild.id, 'movement', { embeds: [updateEmbed] });
    }
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
    if (oldMessage.author?.bot || oldMessage.content === newMessage.content) return;
    const editEmbed = new EmbedBuilder()
        .setTitle("📝 Message Edited")
        .setColor(0xF1C40F)
        .setDescription(`**Author:** <@${oldMessage.author?.id}> in <#${oldMessage.channel.id}>`)
        .addFields(
            { name: "Before", value: oldMessage.content ? oldMessage.content.slice(0, 1024) : "*Empty/Embed*" },
            { name: "After", value: newMessage.content ? newMessage.content.slice(0, 1024) : "*Empty/Embed*" }
        ).setTimestamp();
    dispatchLog(oldMessage.guildId, 'moderator', { embeds: [editEmbed] });
});

client.on('messageDelete', async message => {
    if (message.author?.bot) return;
    const deleteEmbed = new EmbedBuilder()
        .setTitle("🗑️ Message Deleted")
        .setColor(0xE67E22)
        .setDescription(`**Author:** <@${message.author?.id}> in <#${message.channel.id}>`)
        .addFields({ name: "Content Block", value: message.content ? message.content.slice(0, 1024) : "*Empty context or Media file*" })
        .setTimestamp();
    dispatchLog(message.guildId, 'moderator', { embeds: [deleteEmbed] });
});

client.on('channelCreate', async channel => {
    if (!channel.guild) return;
    const createEmbed = new EmbedBuilder()
        .setTitle("✨ Channel Created")
        .setColor(0x3498DB)
        .setDescription(`**Name:** \`${channel.name}\`\n**Identity Route:** <#${channel.id}>`)
        .setTimestamp();
    dispatchLog(channel.guild.id, 'system', { embeds: [createEmbed] });
});

client.on('channelUpdate', async (oldChannel, newChannel) => {
    if (!oldChannel.guild) return;
    if (JSON.stringify(oldChannel.permissionOverwrites.cache) !== JSON.stringify(newChannel.permissionOverwrites.cache)) {
        const permEmbed = new EmbedBuilder()
            .setTitle("🔒 Channel Permissions Altered")
            .setColor(0x34495E)
            .setDescription(`Overwrites adjusted within tracking grid: <#${newChannel.id}>`)
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
        dispatchLog(guildId, 'system', `🚨 **SECURITY ALERT:** Rapid modifications detected! **BEAST MODE ENABLED.**`);
    }
}

client.on('channelDelete', channel => { 
    if (channel.guild) {
        const delEmbed = new EmbedBuilder().setTitle("🚨 Channel Deleted").setColor(0xD35400).setDescription(`\`${channel.name}\` was deleted.`).setTimestamp();
        dispatchLog(channel.guild.id, 'system', { embeds: [delEmbed] });
        incrementSecurityTrigger(channel.guild.id); 
    }
});
client.on('roleDelete', role => { if (role.guild) incrementSecurityTrigger(role.guild.id); });

client.on('messageCreate', async message => {
    if (!message.guild || message.author.bot) return;

    // --- SEPARATE INDIVIDUAL TEXT PREFIX COMMAND HANDLING PIPELINE ---
    if (message.content.startsWith('?')) {
        const structuralArgs = message.content.slice(1).trim().split(/ +/);
        const invokerTarget = structuralArgs.shift().toLowerCase();

        // ?moderation help command block
        if (invokerTarget === 'moderation' || invokerTarget === 'mod') {
            const hasModPerms = message.member.permissions.has(PermissionFlagsBits.ManageMessages) || 
                                message.member.permissions.has(PermissionFlagsBits.KickMembers) || 
                                message.member.permissions.has(PermissionFlagsBits.BanMembers);
            if (!hasModPerms) return;

            const dynoHelpMenuEmbed = new EmbedBuilder()
                .setColor(0x3498DB)
                .setAuthor({ name: `${client.user.username} Help`, iconURL: client.user.displayAvatarURL() })
                .setTitle("Moderator Commands")
                .setDescription(`Custom modules running active across server networks.\nPrefix: \`?\``)
                .addFields(
                    { name: "⚙️ ?purge `[count]`", value: "Delete packages of text logs up to a 100 record limitation buffer.", inline: false },
                    { name: "🔨 ?ban `[user/ID]` `(reason)`", value: "Permanently restrict and ban malicious endpoints from access networks.", inline: false },
                    { name: "👢 ?kick `[user/ID]` `(reason)`", value: "Forcibly eject a targeted profile link connection from the guild matrix.", inline: false },
                    { name: "⏳ ?timeout `[user/ID]` `[minutes]`", value: "Apply a text silencer and restrict message creation variables completely.", inline: false },
                    { name: "🔊 ?unmute `[user/ID]`", value: "Lift isolation and manually restore text communication capability metrics.", inline: false }
                )
                .setFooter({ text: `${message.guild.name} • Page 1 of 1`, iconURL: message.guild.iconURL() })
                .setTimestamp();

            return message.channel.send({ embeds: [dynoHelpMenuEmbed] });
        }

        // ?purge command logic
        if (invokerTarget === 'purge') {
            if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return;
            const count = parseInt(structuralArgs[0]);
            if (!count || isNaN(count) || count < 1 || count > 100) {
                const helpEmbed = new EmbedBuilder()
                    .setTitle("Command: ?purge")
                    .setColor(0x3498DB)
                    .setDescription("**Description:** Delete patches of text logs in bulk.\n**Cooldown:** 3 seconds\n**Usage:**\n`?purge [count]`\n\n**Example:**\n`?purge 50`")
                    .setTimestamp();
                return message.channel.send({ embeds: [helpEmbed] });
            }
            await message.delete().catch(() => {});
            const cleared = await message.channel.bulkDelete(count, true).catch(() => []);
            const logEmbed = new EmbedBuilder().setTitle("🧹 Channel Purged").setColor(0x95A5A6).setDescription(`Cleared \`${cleared.size || cleared}\` records via text command format.`).setTimestamp();
            dispatchLog(message.guild.id, 'system', { embeds: [logEmbed] });
            const feedback = await message.channel.send(`✅ Success: Cleared \`${cleared.size || cleared}\` messages context parameters.`);
            return setTimeout(() => feedback.delete().catch(() => {}), 4000);
        }

        // Helper resolver for raw ping parameters or direct numeric IDs
        const resolveTargetMember = async (argString) => {
            if (!argString) return null;
            const strictId = argString.replace(/[<@!>]/g, '');
            return await message.guild.members.fetch(strictId).catch(() => null);
        };

        // ?ban command logic
        if (invokerTarget === 'ban') {
            if (!message.member.permissions.has(PermissionFlagsBits.BanMembers)) return;
            const targetUser = await resolveTargetMember(structuralArgs[0]);
            if (!targetUser) {
                const helpEmbed = new EmbedBuilder()
                    .setTitle("Command: ?ban")
                    .setColor(0x3498DB)
                    .setDescription("**Description:** Permanently ban a member from the network matrix.\n**Cooldown:** 3 seconds\n**Usage:**\n`?ban [user] [reason]`\n\n**Example:**\n`?ban @NoobLance Terminated.`")
                    .setTimestamp();
                return message.channel.send({ embeds: [helpEmbed] });
            }
            const reason = structuralArgs.slice(1).join(" ") || "No reason specified.";
            await targetUser.ban({ reason: reason });
            return message.reply(`🔨 **${targetUser.user.tag}** has been banned from the server grid matrix.`);
        }

        // ?kick command logic
        if (invokerTarget === 'kick') {
            if (!message.member.permissions.has(PermissionFlagsBits.KickMembers)) return;
            const targetUser = await resolveTargetMember(structuralArgs[0]);
            if (!targetUser) {
                const helpEmbed = new EmbedBuilder()
                    .setTitle("Command: ?kick")
                    .setColor(0x3498DB)
                    .setDescription("**Description:** Kick a member from the server.\n**Cooldown:** 3 seconds\n**Usage:**\n`?kick [user] [reason]`\n\n**Example:**\n`?kick @NoobLance Get out!`")
                    .setTimestamp();
                return message.channel.send({ embeds: [helpEmbed] });
            }
            const reason = structuralArgs.slice(1).join(" ") || "No reason specified.";
            await targetUser.kick(reason);
            return message.reply(`👢 **${targetUser.user.tag}** was forcibly expelled.`);
        }

        // ?timeout command logic
        if (invokerTarget === 'timeout') {
            if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return;
            const targetUser = await resolveTargetMember(structuralArgs[0]);
            const dynamicMinutes = parseInt(structuralArgs[1]);

            if (!targetUser || isNaN(dynamicMinutes) || dynamicMinutes <= 0) {
                const helpEmbed = new EmbedBuilder()
                    .setTitle("Command: ?timeout")
                    .setColor(0x3498DB)
                    .setDescription("**Description:** Put a member in temporary isolation.\n**Cooldown:** 3 seconds\n**Usage:**\n`?timeout [user] [minutes]`\n\n**Example:**\n`?timeout @NoobLance 10`")
                    .setTimestamp();
                return message.channel.send({ embeds: [helpEmbed] });
            }

            await targetUser.timeout(dynamicMinutes * 60 * 1000);
            return message.reply(`⏳ **${targetUser.user.tag}** isolated into isolation cells for ${dynamicMinutes} minutes.`);
        }

        // ?unmute command logic
        if (invokerTarget === 'unmute') {
            if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return;
            const targetUser = await resolveTargetMember(structuralArgs[0]);
            if (!targetUser) {
                const helpEmbed = new EmbedBuilder()
                    .setTitle("Command: ?unmute")
                    .setColor(0x3498DB)
                    .setDescription("**Description:** Restore text capability arrays to muted targets.\n**Cooldown:** 3 seconds\n**Usage:**\n`?unmute [user]`\n\n**Example:**\n`?unmute @NoobLance`")
                    .setTimestamp();
                return message.channel.send({ embeds: [helpEmbed] });
            }
            await targetUser.timeout(null);
            return message.reply(`🔊 Communication channel array elements restored for **${targetUser.user.tag}**.`);
        }
    }

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
            protectionReason = `pings to <@${targetConfig.userId}> are restricted`;
        }
        if (targetConfig.roleId && message.mentions.roles.has(targetConfig.roleId)) {
            triggeredProtection = true;
            protectionReason = `pings to <@&${targetConfig.roleId}> are restricted`;
        }
    }

    if ((totalMentions > 4 && !isDiscordReply) || triggeredProtection) {
        if (!protectionReason) protectionReason = "mass mentions are forbidden while anti-mention shield is active";
        try {
            await message.delete();
            dispatchLog(message.guild.id, 'moderator', `🛡️ **Anti-Mention Shield:** Blocked message from <@${message.author.id}> in <#${message.channel.id}>.`);
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
                .setDescription(`To verify as **${usernameInput}**, append the security token inside your Roblox account Bio description.\n\nOnce updated, rerun \`/verify username:${usernameInput}\` to match successfully.`)
                .addFields({ name: "Required Verification Key:", value: `\`${generatedSecretCode}\`` })
                .setColor(0xF1C40F);
            
            return interaction.editReply({ embeds: [challengeEmbed] });
        }

        verificationCodes.delete(lookupKey);
        data.users[targetUser.id] = rId;
        saveData();

        try {
            const memberTarget = await interaction.guild.members.fetch(targetUser.id);
            
            // Remove unverified role if they have it
            const activeUnverifiedId = data.unverifiedRoleId?.[interaction.guildId];
            if (activeUnverifiedId && memberTarget.roles.cache.has(activeUnverifiedId)) {
                await memberTarget.roles.remove(activeUnverifiedId).catch(() => {});
            }

            const activeVerifiedRoleId = data.verifiedRoleId?.[interaction.guildId];
            if (activeVerifiedRoleId) {
                const targetRoleObj = interaction.guild.roles.cache.get(activeVerifiedRoleId);
                if (targetRoleObj) {
                    await memberTarget.roles.add(targetRoleObj).catch(() => {});
                }
            }
        } catch (roleErr) {
            console.error("Failed executing automated role attachment routing pipeline:", roleErr.message);
        }

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
    if (!robloxId) return interaction.editReply("❌ Connect identity profile details using `/verify` first.");
    
    const serverBinds = data.binds ? data.binds[interaction.guildId] : [];
    const userInvData = data.invites[interaction.guildId]?.[targetUser.id] || { regular: 0, left: 0 };
    const netInvites = userInvData.regular - userInvData.left;

    try {
        let added = [], removed = [];
        const targetMember = await interaction.guild.members.fetch(targetUser.id);
        
        const gRes = await axios.get(`https://groups.roproxy.com/v2/users/${robloxId}/groups/roles`);
        const userGroupsCache = gRes.data.data; 

        const uLookup = await axios.get(`https://users.roproxy.com/v1/users/${robloxId}`);
        const robloxName = uLookup.data.name;

        let primaryGroupRankId = 0;
        if (userGroupsCache.length > 0) {
            primaryGroupRankId = userGroupsCache[0].role.rank;
        }

        for (const b of serverBinds) {
            const role = interaction.guild.roles.cache.get(b.roleId);
            if (role) {
                const targetedMatch = userGroupsCache.find(g => g.group.id.toString() === b.groupId.toString());
                const specificUserRank = targetedMatch ? targetedMatch.role.rank : 0;

                if (specificUserRank === b.rankId && netInvites >= (b.minInvites || 0)) { 
                    if (!targetMember.roles.cache.has(role.id)) { await targetMember.roles.add(role); added.push(role.name); }
                    await applyUserRankMutations(targetMember, robloxId, b, robloxName);
                } else if (targetMember.roles.cache.has(role.id)) { 
                    const safetyDuplicateCheck = serverBinds.some(otherB => {
                        if (otherB.roleId !== b.roleId) return false;
                        const altMatch = userGroupsCache.find(g => g.group.id.toString() === otherB.groupId.toString());
                        return altMatch && altMatch.role.rank === otherB.rankId;
                    });
                    if (!safetyDuplicateCheck) {
                        await targetMember.roles.remove(role); 
                        removed.push(role.name); 
                    }
                }
            }
        }

        const sRolesMap = data.milestoneRoles[interaction.guildId] || {};
        const sThresholds = data.milestoneThresholds[interaction.guildId] || {};

        for (const [poolKey, roleIdsArray] of Object.entries(sRolesMap)) {
            const parsedMeta = poolKey.split('_');
            const targetGroupId = parsedMeta[0];
            
            const targetedMatch = userGroupsCache.find(g => g.group.id.toString() === targetGroupId.toString());
            const evaluatedRank = targetedMatch ? targetedMatch.role.rank : 0;

            const minRequiredRank = sThresholds[poolKey] ?? 0;
            const qualifies = evaluatedRank >= minRequiredRank;

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
                { name: "Trooper:", value: `<@${targetUser.id}>`, inline: true },
                { name: "Main Group Rank ID:", value: `\`${primaryGroupRankId}\``, inline: true },
                { name: "Updates Processed:", value: added.length > 0 ? `+ Added: ${added.join(', ')}\n- Removed: ${removed.join(', ')}` : "No changes applied.", inline: false }
            );
        return interaction.editReply({ embeds: [embed] });
    } catch (e) { console.error(e); return interaction.editReply("❌ Error processing updates across groups."); }
}

client.on('interactionCreate', async interaction => {
    if (interaction.isButton()) {
        if (interaction.customId === 'panel_update_btn') {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            return await runUpdateProcess(interaction, interaction.user);
        }
        if (interaction.customId === 'panel_link_btn') {
            return interaction.reply({ content: "Execute command `/verify` to link accounts.", flags: [MessageFlags.Ephemeral] });
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

                const welcomeTicketEmbed = new EmbedBuilder().setTitle(`🎫 Support Ticket #${countStr}`).setDescription(`Supply inquiry parameters explicitly here.`).setColor(0x3498DB);
                const closeActionRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('close_ticket_btn').setLabel('Close Ticket').setStyle(ButtonStyle.Danger));

                await ticketChannel.send({ embeds: [welcomeTicketEmbed], components: [closeActionRow] });
                dispatchLog(interaction.guildId, 'system', `🎟️ **Ticket Opened:** <@${interaction.user.id}> initialized channel <#${ticketChannel.id}>.`);
                return interaction.editReply(`✅ Support channel link built: <#${ticketChannel.id}>`);
            } catch (err) { return interaction.editReply("❌ Pipeline allocation error."); }
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

    if (commandName === 'setup-verified-role') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        
        const targetRole = options.getRole('role');
        if (!data.verifiedRoleId) data.verifiedRoleId = {};
        
        data.verifiedRoleId[guildId] = targetRole.id;
        saveData();

        return interaction.editReply(`✅ **Verified Role Saved:** Bot will automatically assign <@&${targetRole.id}> upon profile verification.`);
    }

    if (commandName === 'setup-unverified-role') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        
        const targetRole = options.getRole('role');
        if (!data.unverifiedRoleId) data.unverifiedRoleId = {};
        
        data.unverifiedRoleId[guildId] = targetRole.id;
        saveData();

        return interaction.editReply(`✅ **Unverified Role Saved:** Incoming new users will automatically be granted <@&${targetRole.id}> upon joining until verified.`);
    }

    if (commandName === 'setup-logs') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        const categorySelection = options.getString('category');
        const targetChannel = options.getChannel('channel');

        if (!targetChannel.isTextBased()) return interaction.editReply("❌ Target allocation selection must be text-based.");
        if (!data.logsChannels) data.logsChannels = { system: null, moderator: null, movement: null };
        if (!data.logsChannels[categorySelection]) data.logsChannels[categorySelection] = {};
        
        data.logsChannels[categorySelection][guildId] = targetChannel.id;
        saveData();
        return interaction.editReply(`✅ Log configuration saved for channel: <#${targetChannel.id}>.`);
    }

    if (commandName === 'purge') {
        if (!member.permissions.has(PermissionFlagsBits.ManageMessages)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        const targetAmount = options.getInteger('amount');
        if (targetAmount < 1 || targetAmount > 100) return interaction.editReply("❌ Metrics constraints must remain between 1 and 100 entries.");

        const clearPackets = await channel.bulkDelete(targetAmount, true).catch(() => []);
        const purgeEmbed = new EmbedBuilder().setTitle("🧹 Channel Purged").setColor(0x95A5A6).setDescription(`Cleared \`${clearPackets.size}\` records.`).setTimestamp();
        dispatchLog(guildId, 'system', { embeds: [purgeEmbed] });
        return interaction.editReply(`✅ Cleared \`${clearPackets.size}\` records.`);
    }

    if (commandName === 'bind') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        
        const groupId = options.getString('groupid').trim();
        const rankId = options.getInteger('rankid');
        const role = options.getRole('role');
        const nicknameFormat = options.getString('nickname-format') || null;
        const minInvites = options.getInteger('min-invites') || 0;

        if (!data.binds[guildId]) data.binds[guildId] = [];
        data.binds[guildId] = data.binds[guildId].filter(b => !(b.groupId === groupId && b.rankId === rankId));
        
        data.binds[guildId].push({ groupId, rankId, roleId: role.id, nicknameFormat, minInvites });
        saveData();
        return interaction.editReply(`✅ Successfully linked **Group ${groupId} (Rank ${rankId})** directly to role <@&${role.id}>.`);
    }

    if (commandName === 'sync-group-roles') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        const targetGroupId = options.getString('groupid').trim();
        
        try {
            const rRoles = (await axios.get(`https://groups.roproxy.com/v1/groups/${targetGroupId}/roles`)).data.roles.filter(r => r.rank > 0).sort((a, b) => a.rank - b.rank);
            if (!data.binds[guildId]) data.binds[guildId] = [];
            const existingRoles = await interaction.guild.roles.fetch();

            for (const r of rRoles) {
                data.binds[guildId] = data.binds[guildId].filter(b => !(b.groupId === targetGroupId && b.rankId === r.rank));
                let existingRole = existingRoles.find(role => role.name === r.name);
                if (!existingRole) existingRole = await interaction.guild.roles.create({ name: r.name, reason: `Auto-sync group ${targetGroupId}` });
                data.binds[guildId].push({ groupId: targetGroupId, rankId: r.rank, roleId: existingRole.id, nicknameFormat: null, minInvites: 0 });
            }
            saveData();
            return interaction.editReply(`🎉 **Sync complete!** All ranks for Group \`${targetGroupId}\` have been generated and mapped.`);
        } catch (e) { return interaction.editReply(`❌ Sync failed: ${e.message}`); }
    }

    if (commandName === 'setup-milestones') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();

        const targetGroupId = options.getString('groupid').trim();
        const categoryName = options.getString('category-name').toLowerCase().replace(/\s+/g, '_');
        const rolesListString = options.getString('roles-list');
        const minRank = options.getInteger('min-rank');
        const parsedIds = [...rolesListString.matchAll(/\d+/g)].map(match => match[0]);

        if (!parsedIds.length) return interaction.editReply("❌ No valid Discord roles extracted.");
        const storagePoolKey = `${targetGroupId}_${categoryName}`;

        if (!data.milestoneRoles) data.milestoneRoles = {};
        if (!data.milestoneThresholds) data.milestoneThresholds = {};
        if (!data.milestoneRoles[guildId]) data.milestoneRoles[guildId] = {};
        if (!data.milestoneThresholds[guildId]) data.milestoneThresholds[guildId] = {};

        data.milestoneRoles[guildId][storagePoolKey] = parsedIds;
        data.milestoneThresholds[guildId][storagePoolKey] = minRank;
        saveData();
        return interaction.editReply(`✅ Milestone saved. Anyone at or above **Rank ${minRank}** in **Group ${targetGroupId}** receives these pool roles.`);
    }

    if (commandName === 'view-binds') {
        await interaction.deferReply();
        const serverBinds = data.binds ? data.binds[guildId] : [];
        if (!serverBinds.length) return interaction.editReply("❌ No active group binds configured.");
        let bindList = serverBinds.map(b => `• **Group ${b.groupId} (Rank ${b.rankId})** → <@&${b.roleId}>`);
        return interaction.editReply({ embeds: [new EmbedBuilder().setTitle("Configured Multi-Group Binds").setDescription(bindList.join('\n'))] });
    }

    if (commandName === 'autorole') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        const selectedRole = options.getRole('role');
        if (!data.autoroles) data.autoroles = {};
        if (!Array.isArray(data.autoroles[guildId])) data.autoroles[guildId] = [];

        if (!selectedRole) {
            const activeIds = data.autoroles[guildId];
            if (!activeIds.length) return interaction.editReply("ℹ️ No active welcome configurations.");
            return interaction.editReply(`ℹ️ Active roles: ${activeIds.map(id => `<@&${id}>`).join(', ')}`);
        }

        if (data.autoroles[guildId].includes(selectedRole.id)) {
            data.autoroles[guildId] = data.autoroles[guildId].filter(id => id !== selectedRole.id);
            saveData();
            return interaction.editReply(`✅ **Autorole Removed:** <@&${selectedRole.id}> dropped.`);
        } else {
            data.autoroles[guildId].push(selectedRole.id);
            saveData();
            return interaction.editReply(`✅ **Autorole Added:** <@&${selectedRole.id}> added.`);
        }
    }

    if (commandName === 'ban') {
        if (!member.permissions.has(PermissionFlagsBits.BanMembers)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        const targetUser = options.getUser('target');
        const coreReason = options.getString('reason') || "No formal reasoning logged.";
        await interaction.guild.members.ban(targetUser, { reason: coreReason });
        return interaction.editReply("🚨 Account banned.");
    }

    if (commandName === 'unban') {
        if (!member.permissions.has(PermissionFlagsBits.BanMembers)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        const userIdInput = options.getString('userid');
        try {
            await interaction.guild.members.unban(userIdInput);
            return interaction.editReply(`✅ Successfully unbanned user ID: \`${userIdInput}\``);
        } catch (err) { return interaction.editReply(`❌ Action failed: ${err.message}`); }
    }
    
    if (commandName === 'kick') {
        if (!member.permissions.has(PermissionFlagsBits.KickMembers)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        await options.getMember('target').kick();
        return interaction.editReply("👢 Member kicked.");
    }

    if (commandName === 'timeout') {
        if (!member.permissions.has(PermissionFlagsBits.ModerateMembers)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        await options.getMember('target').timeout(options.getInteger('minutes') * 60 * 1000);
        return interaction.editReply("⏳ Member isolated.");
    }

    if (commandName === 'unmute') {
        if (!member.permissions.has(PermissionFlagsBits.ModerateMembers)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        await options.getMember('target').timeout(null);
        return interaction.editReply("🔊 Isolation lifted.");
    }

    if (commandName === 'sync-milestones') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        return await runUpdateProcess(interaction, options.getUser('target'));
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
        return interaction.editReply(`🛡️ Anti-Mention parameters synchronized.`);
    }

    if (commandName === 'antimention-remove') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        if (data.antimention) data.antimention[guildId] = false;
        if (data.protectedTargets) data.protectedTargets[guildId] = { userId: null, roleId: null };
        saveData();
        return interaction.editReply("✅ Anti-mention shield wiped.");
    }

    if (commandName === 'security-config') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        const activeSetting = options.getBoolean('active');
        const customThreshold = options.getInteger('beast-threshold');
        const finalLimit = customThreshold !== null ? customThreshold : (data.security[guildId]?.limit || 4);

        data.security[guildId] = { enabled: activeSetting, beastMode: data.security[guildId]?.beastMode || false, limit: finalLimit };
        saveData();
        return interaction.editReply(`🛡️ Security infrastructure parameters saved.`);
    }

    if (commandName === 'beast-disable') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        if (data.security[guildId]) data.security[guildId].beastMode = false;
        saveData();
        return interaction.editReply("✅ **BEAST MODE RESET FINALIZED.**");
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
        const panelEmbed = new EmbedBuilder().setTitle("Identity Hub").setDescription("Interact below to update linked profiles.").setColor(0x355eed);
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
        if (wait) return interaction.reply({ content: `⏳ Cooldown: ${wait}s`, flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        return await runVerificationProcess(interaction, options.getString('username'), targetUser || interaction.user);
    }

    if (commandName === 'tickets') {
        if (options.getSubcommand() === 'setup') {
            if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
            await interaction.deferReply();
            const ticketEmbed = new EmbedBuilder().setTitle("🎫 Support Operations Panel").setDescription("Engage module to open a ticket workspace.").setColor(0x2ECC71);
            const btnRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_ticket_btn').setLabel('Open Ticket').setStyle(ButtonStyle.Primary).setEmoji('📩'));
            await channel.send({ embeds: [ticketEmbed], components: [btnRow] });
            return interaction.editReply("✅ Interactive support panel online.");
        }
    }

    if (commandName === 'update') {
        await interaction.deferReply();
        const targetUser = options.getUser('user') || interaction.user;
        if (targetUser.id !== interaction.user.id && !member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.editReply("❌ Unauthorized profile sync.");
        }
        return await runUpdateProcess(interaction, targetUser);
    }

    if (commandName === 'invites-leaderboard') {
        await interaction.deferReply();
        const serverInvs = data.invites[guildId] || {};
        const sorted = Object.entries(serverInvs).map(([id, val]) => ({ id, total: (val.regular || 0) - (val.left || 0) + (val.bonus || 0) })).sort((a, b) => b.total - a.total).slice(0, 10);
        if (!sorted.length) return interaction.editReply("No invite entries found.");
        let lines = sorted.map((u, i) => `\`#${i + 1}\` <@${u.id}>: **${u.total}** invites.`);
        return interaction.editReply({ embeds: [new EmbedBuilder().setTitle("Leaderboard").setDescription(lines.join('\n')).setColor(0x00FFFF)] });
    }

    if (commandName === 'giveaway') {
        return interaction.reply({ content: "🎉 Systems operational...", flags: [MessageFlags.Ephemeral] });
    }
});

client.login(process.env.BOT_TOKEN);
