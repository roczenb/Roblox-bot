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
    MessageType
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
    security: {},
    autoroles: {},
    milestoneRoles: {}, 
    milestoneThresholds: {},
    logsChannel: {} 
};

// Temporary cache to hold active verification codes
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
            if (!data.logsChannel) data.logsChannel = {};
        }
    } catch (e) { console.log("Local Volume DB initialization setup."); }
}

function saveData() {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); } catch (e) { console.error(e); }
}

loadData();

function sendSystemLog(guildId, logPayload) {
    const channelId = data.logsChannel?.[guildId];
    if (!channelId) return;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    const targetChannel = guild.channels.cache.get(channelId);
    if (targetChannel && targetChannel.isTextBased()) {
        targetChannel.send(logPayload).catch(err => console.error("Failed to route log packet:", err.message));
    }
}

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
    new SlashCommandBuilder().setName('setup-logs').setDescription('Admin Only: Configure which channel the bot sends moderation and invite logs to')
        .addChannelOption(o => o.setName('channel').setDescription('The channel to receive logs').setRequired(true)),
    new SlashCommandBuilder().setName('view-binds').setDescription('View all Roblox rank-to-role connections for this server'),
    new SlashCommandBuilder().setName('updateall').setDescription('Lead Command Only: Update every verified member in the server at once'),
    new SlashCommandBuilder().setName('verification-panel').setDescription('Admin Only: Post the interactive verification embed panel with buttons'),
    new SlashCommandBuilder().setName('autorole').setDescription('Admin Only: Configure a role given to all members instantly upon joining')
        .addRoleOption(o => o.setName('role').setDescription('The role to auto-assign on join').setRequired(false)),
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
    new SlashCommandBuilder().setName('giveaway').setDescription('Manage community giveaways').addSubcommand(s => s.setName('create').setDescription('Initialize a server giveaway package')),
    new SlashCommandBuilder().setName('tickets').setDescription('Open or configuration process helper ticket pipelines')
].map(c => c.toJSON());

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
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
            await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
        }
        console.log('All slash commands are synced globally!');
    } catch (e) { console.error('Command registration failed:', e); }
});

client.on('inviteCreate', invite => {
    const cache = guildInvitesCache.get(invite.guild.id);
    if (cache) cache.set(invite.code, invite.uses);
});

client.on('guildMemberAdd', async member => {
    if (data.security[member.guild.id]?.beastMode) {
        try {
            await member.send("⚠️ This server is under high security lockdown. Entrance invitations are paused.");
            await member.kick("Beast Mode: Anti-Raid Active Protection Layer");
            sendSystemLog(member.guild.id, `🚨 **Beast Mode Action:** Kick executed on joining user <@${member.id}> (Security Lockout).`);
            return;
        } catch (e) { console.error(e); }
    }

    const activeAutoRoleId = data.autoroles?.[member.guild.id];
    if (activeAutoRoleId) {
        const targetJoinRole = member.guild.roles.cache.get(activeAutoRoleId);
        if (targetJoinRole) {
            await member.roles.add(targetJoinRole).catch(err => console.log("Auto-assignment execution block:", err.message));
        }
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

        sendSystemLog(member.guild.id, `📥 **Member Joined:** <@${member.id}> invited by <@${usedBy}> (Code: \`${inviteCodeUsed}\`).`);
    }
});

client.on('guildMemberRemove', async member => {
    const log = data.logs[member.id];
    if (log && data.invites[member.guild.id]?.[log.inviter]) {
        data.invites[member.guild.id][log.inviter].left += 1;
        saveData();

        sendSystemLog(member.guild.id, `📤 **Member Left:** <@${member.id}> (Originally invited by <@${log.inviter}>).`);
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
        const msg = `🚨 **SECURITY ALERT:** Rapid structural deletions detected (${dynamicFilter.length}/${criticalThreshold})! **BEAST MODE ENABLED.** Invites are paused, and entry points are locked down.`;
        sendSystemLog(guildId, msg);
        const channel = client.guilds.cache.get(guildId).channels.cache.find(c => c.isTextBased());
        if (channel) channel.send(msg);
    }
}

client.on('channelDelete', channel => { if (channel.guild) incrementSecurityTrigger(channel.guild.id); });
client.on('roleDelete', role => { if (role.guild) incrementSecurityTrigger(role.guild.id); });

client.on('messageCreate', async message => {
    if (!message.guild || message.author.bot) return;

    if (message.content.startsWith('?ban') || message.content.startsWith('?kick') || message.content.startsWith('?timeout')) {
        if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return;
        return message.channel.send(`⚙️ **[SYSTEM OPERATION EXECUTION]**: Target confirmation sequence acknowledged. Preparing data packets...`);
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
            sendSystemLog(message.guild.id, `🛡️ **Anti-Mention Shield:** Deleted message from <@${message.author.id}> in <#${message.channel.id}> due to violation: *${protectionReason}*.`);
            const warning = await message.channel.send(`⚠️ <@${message.author.id}>, ${protectionReason}.`);
            setTimeout(() => warning.delete().catch(() => {}), 5000);
        } catch (err) { console.log(err.message); }
    }
});

async function applyUserRankMutations(member, robloxId, bindConfig, username) {
    if (bindConfig.nicknameFormat) {
        let structuredName = bindConfig.nicknameFormat.replace('{roblox_username}', username);
        if (structuredName.length <= 32) {
            await member.setNickname(structuredName).catch(() => {});
        }
    }
}

async function runVerificationProcess(interaction, usernameInput, targetUser) {
    try {
        const res = await axios.post('https://users.roproxy.com/v1/usernames/users', { usernames: [usernameInput], excludeBannedUsers: true });
        if (!res.data.data.length) return interaction.editReply("❌ User not found on Roblox.");
        const rId = res.data.data[0].id;
        
        // --- SECURE OATH PROTOCOL: ACCOUNT BIO LOOKUP ---
        const lookupKey = `verify_${interaction.user.id}`;
        const activePendingCode = verificationCodes.get(lookupKey);

        const profileLookup = await axios.get(`https://users.roproxy.com/v1/users/${rId}`);
        const userDescription = profileLookup.data.description || "";

        if (!activePendingCode || !userDescription.includes(activePendingCode)) {
            // Generate a fresh code and challenge the user to update their status description
            const generatedSecretCode = `CT-${Math.floor(100000 + Math.random() * 900000)}`;
            verificationCodes.set(lookupKey, generatedSecretCode);

            const challengeEmbed = new EmbedBuilder()
                .setTitle("🛡️ Confirm Profile Ownership")
                .setDescription(`To verify as **${usernameInput}**, please append the security token below inside your Roblox account **About** bio text description.\n\nOnce updated, rerun the command \`/verify username:${usernameInput}\` to link successfully.`)
                .addFields({ name: "Required Verification Key:", value: `\`${generatedSecretCode}\`` })
                .setColor(0xF1C40F);
            
            return interaction.editReply({ embeds: [challengeEmbed] });
        }

        // Clean cache tokens on clear match confirmation success
        verificationCodes.delete(lookupKey);
        
        data.users[targetUser.id] = rId;
        saveData();

        const logEmbed = new EmbedBuilder()
            .setTitle("🔑 Account Verified")
            .setColor(0x3498DB)
            .addFields(
                { name: "Target User:", value: `<@${targetUser.id}> (\`${targetUser.id}\`)`, inline: true },
                { name: "Roblox Identity:", value: `\`${usernameInput}\` (\`${rId}\`)`, inline: true },
                { name: "Verified By:", value: `<@${interaction.user.id}>`, inline: false }
            )
            .setTimestamp();
        sendSystemLog(interaction.guildId, { embeds: [logEmbed] });

        return interaction.editReply(`✅ Successfully verified <@${targetUser.id}> globally as Roblox ID: ${rId}`);
    } catch (e) { return interaction.editReply(`❌ Error: ${e.message}`); }
}

async function runUpdateProcess(interaction, targetUser) {
    const robloxId = data.users[targetUser.id];
    if (!robloxId) return interaction.editReply(targetUser.id !== interaction.user.id ? `❌ That user has not run \`/verify\` yet.` : "❌ You need to connect your profile first.");
    
    const serverBinds = data.binds ? data.binds[interaction.guildId] : [];
    const userInvData = data.invites[interaction.guildId]?.[targetUser.id] || { regular: 0, left: 0 };
    const netInvites = userInvData.regular - userInvData.left;

    try {
        let added = [];
        let removed = [];
        const targetMember = await interaction.guild.members.fetch(targetUser.id);
        const gRes = await axios.get(`https://groups.roproxy.com/v2/users/${robloxId}/groups/roles`);
        const uLookup = await axios.get(`https://users.roproxy.com/v1/users/${robloxId}`);
        const robloxName = uLookup.data.name;
        
        const sRolesMap = data.milestoneRoles[interaction.guildId] || {};
        const sThresholds = data.milestoneThresholds[interaction.guildId] || {};

        const primaryGroupId = data.groups?.[interaction.guildId];
        if (!primaryGroupId) {
            return interaction.editReply("❌ Primary group configuration missing. Please run `/setup-group` to assign a valid group ID.");
        }
        
        const primaryMatch = gRes.data.data.find(g => g.group.id.toString() === primaryGroupId.toString());
        const mainGroupRank = primaryMatch ? primaryMatch.role.rank : 0;

        // --- Standard 1-to-1 individual binds ---
        for (const b of serverBinds) {
            const role = interaction.guild.roles.cache.get(b.roleId);
            if (role) {
                const currentBindGroupMatch = gRes.data.data.find(g => g.group.id.toString() === b.groupId.toString());
                const specificUserRank = currentBindGroupMatch ? currentBindGroupMatch.role.rank : 0;

                if (specificUserRank === b.rankId && netInvites >= (b.minInvites || 0)) { 
                    if (!targetMember.roles.cache.has(role.id)) {
                        await targetMember.roles.add(role); 
                        added.push(role.name); 
                    }
                    await applyUserRankMutations(targetMember, robloxId, b, robloxName);
                } else if (targetMember.roles.cache.has(role.id)) { 
                    await targetMember.roles.remove(role); 
                    removed.push(role.name);
                }
            }
        }

        // --- Multi-role threshold iteration ---
        for (const [categoryKey, roleIdsArray] of Object.entries(sRolesMap)) {
            const minRequiredRank = sThresholds[categoryKey] ?? 0;
            const qualifies = mainGroupRank >= minRequiredRank;

            if (Array.isArray(roleIdsArray)) {
                for (const rId of roleIdsArray) {
                    const discordRole = interaction.guild.roles.cache.get(rId);
                    if (!discordRole) continue;

                    const hasRole = targetMember.roles.cache.has(rId);
                    if (qualifies && !hasRole) {
                        await targetMember.roles.add(discordRole).catch(() => {});
                        added.push(discordRole.name);
                    } else if (!qualifies && hasRole) {
                        await targetMember.roles.remove(discordRole).catch(() => {});
                        removed.push(discordRole.name);
                    }
                }
            }
        }

        if (added.length > 0 || removed.length > 0) {
            const syncAuditEmbed = new EmbedBuilder()
                .setTitle("🔄 Verification Sync Log")
                .setColor(0xE67E22)
                .addFields(
                    { name: "Target Trooper:", value: `<@${targetUser.id}>`, inline: true },
                    { name: "Roblox Profile Name:", value: `\`${robloxName}\``, inline: true },
                    { name: "Roles Granted:", value: added.length > 0 ? added.map(r => `+ ${r}`).join('\n') : "*None*", inline: false },
                    { name: "Roles Revoked:", value: removed.length > 0 ? removed.map(r => `- ${r}`).join('\n') : "*None*", inline: false }
                )
                .setTimestamp();
            sendSystemLog(interaction.guildId, { embeds: [syncAuditEmbed] });
        }

        const embed = new EmbedBuilder()
            .setTitle("Clone Trooper Profile Synced")
            .setColor(0x2ECC71) 
            .addFields(
                { name: "Trooper:", value: `<@${targetUser.id}>`, inline: true },
                { name: "Main Group Rank ID:", value: `\`${mainGroupRank}\``, inline: true },
                { name: "Updates Processed:", value: added.length > 0 ? added.join('\n') : "No changes applied." }
            );
        return interaction.editReply({ embeds: [embed] });
    } catch (e) { 
        console.error(e);
        return interaction.editReply("❌ Update network error processing thresholds."); 
    }
}

client.on('interactionCreate', async interaction => {
    if (interaction.isButton()) {
        if (interaction.customId === 'panel_update_btn') {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            return await runUpdateProcess(interaction, interaction.user);
        }
        if (interaction.customId === 'panel_link_btn') {
            return interaction.reply({ content: "Please execute the `/verify` command to securely register your identity.", flags: [MessageFlags.Ephemeral] });
        }
    }

    if (!interaction.isChatInputCommand()) return;
    const { commandName, options, guildId, member, channel, guild } = interaction;

    if (commandName === 'setup-logs') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        }
        await interaction.deferReply();
        const targetChannel = options.getChannel('channel');

        if (!targetChannel.isTextBased()) {
            return interaction.editReply("❌ Please select a text-based channel.");
        }

        if (!data.logsChannel) data.logsChannel = {};
        data.logsChannel[guildId] = targetChannel.id;
        saveData();
        return interaction.editReply(`✅ **Logging Channel Saved:** Log entries will now stream directly to <#${targetChannel.id}>.`);
    }

    if (commandName === 'autorole') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        }
        await interaction.deferReply();
        const selectedRole = options.getRole('role');

        if (!selectedRole) {
            const cachedId = data.autoroles?.[guildId];
            if (!cachedId) return interaction.editReply("ℹ️ No autorole configuration active on this server yet.");
            return interaction.editReply(`ℹ️ Users currently receive role: <@&${cachedId}> upon entry point connection.`);
        }

        if (!data.autoroles) data.autoroles = {};
        data.autoroles[guildId] = selectedRole.id;
        saveData();
        return interaction.editReply(`✅ **Autorole Saved:** All users joining the server will now instantly be granted <@&${selectedRole.id}>.`);
    }

    if (commandName === 'sync-milestones') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        }
        await interaction.deferReply();
        const targetTrooper = options.getUser('target');
        return await runUpdateProcess(interaction, targetTrooper);
    }

    if (commandName === 'setup-milestones') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        }
        await interaction.deferReply();

        const categoryName = options.getString('category-name').toLowerCase().replace(/\s+/g, '_');
        const rolesListString = options.getString('roles-list');
        const minRank = options.getInteger('min-rank');

        const parsedIds = [...rolesListString.matchAll(/\d+/g)].map(match => match[0]);

        if (!parsedIds.length) {
            return interaction.editReply("❌ No valid Discord roles could be extracted from your text. Make sure to mention them or separate them using commas.");
        }

        if (!data.milestoneRoles) data.milestoneRoles = {};
        if (!data.milestoneThresholds) data.milestoneThresholds = {};
        if (!data.milestoneRoles[guildId]) data.milestoneRoles[guildId] = {};
        if (!data.milestoneThresholds[guildId]) data.milestoneThresholds[guildId] = {};

        data.milestoneRoles[guildId][categoryName] = parsedIds;
        data.milestoneThresholds[guildId][categoryName] = minRank;

        saveData();
        return interaction.editReply(`✅ **Threshold Saved:** Anyone with Roblox Rank **${minRank}+** will receive all **${parsedIds.length}** configured roles mapped within pool key: \`${categoryName}\`.`);
    }

    if (commandName === 'bind') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        }
        await interaction.deferReply();
        
        const rankId = options.getInteger('rankid');
        const role = options.getRole('role');
        const nicknameFormat = options.getString('nickname-format') || null;
        const minInvites = options.getInteger('min-invites') || 0;
        const groupId = data.groups?.[guildId];

        if (!groupId) {
            return interaction.editReply("❌ Please associate a Roblox Group ID using `/setup-group` first.");
        }

        if (!data.binds[guildId]) data.binds[guildId] = [];
        data.binds[guildId] = data.binds[guildId].filter(b => !(b.groupId === groupId && b.rankId === rankId));
        
        data.binds[guildId].push({ groupId, rankId, roleId: role.id, nicknameFormat, minInvites });
        saveData();
        return interaction.editReply(`✅ Successfully linked **Rank ${rankId}** directly to role <@&${role.id}>.`);
    }

    if (commandName === 'antimention') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        }
        await interaction.deferReply();

        const enabledSetting = options.getBoolean('enabled');
        const protectUser = options.getUser('protect-user');
        const protectRole = options.getRole('protect-role');

        if (!data.antimention) data.antimention = {};
        if (!data.protectedTargets) data.protectedTargets = {};

        data.antimention[guildId] = enabledSetting;

        if (enabledSetting) {
            data.protectedTargets[guildId] = {
                userId: protectUser ? protectUser.id : null,
                roleId: protectRole ? protectRole.id : null
            };
        }

        saveData();
        return interaction.editReply(`🛡️ **Anti-Mention Settings Updated:**\n• Active Shield status: **${enabledSetting}**\n• Targeting User constraints: ${protectUser ? `<@${protectUser.id}>` : '**None**'}\n• Targeting Role constraints: ${protectRole ? `<@&${protectRole.id}>` : '**None**'}`);
    }

    if (commandName === 'antimention-remove') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        }
        await interaction.deferReply();
        
        if (data.antimention) data.antimention[guildId] = false;
        if (data.protectedTargets) data.protectedTargets[guildId] = { userId: null, roleId: null };
        
        saveData();
        return interaction.editReply("✅ Anti-mention constraints wiped clean.");
    }

    if (commandName === 'security-config') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        
        const activeSetting = options.getBoolean('active');
        const customThreshold = options.getInteger('beast-threshold');
        const finalLimit = customThreshold !== null ? customThreshold : (data.security[guildId]?.limit || 4);

        if (finalLimit < 1) return interaction.editReply("❌ Limit must be 1 or higher.");
        data.security[guildId] = { enabled: activeSetting, beastMode: data.security[guildId]?.beastMode || false, limit: finalLimit };
        saveData();
        return interaction.editReply(`🛡️ **Security Protocol Saved:**\n• Active: **${activeSetting}**\n• Limit Threshold: **${finalLimit} modifications**`);
    }

    if (commandName === 'beast-disable') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        if (data.security[guildId]) data.security[guildId].beastMode = false;
        saveData();
        return interaction.editReply("✅ **BEAST MODE DEACTIVATED.**");
    }

    if (commandName === 'ban') {
        if (!member.permissions.has(PermissionFlagsBits.BanMembers)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        await interaction.guild.members.ban(options.getUser('target'));
        return interaction.editReply("🚨 Account banned.");
    }

    if (commandName === 'unban') {
        if (!member.permissions.has(PermissionFlagsBits.BanMembers)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        const userIdInput = options.getString('userid');
        try {
            await interaction.guild.members.unban(userIdInput);
            return interaction.editReply(`✅ Successfully unbanned user ID: \`${userIdInput}\``);
        } catch (err) {
            return interaction.editReply(`❌ Failed to unban user: ${err.message}`);
        }
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
        const targetMember = options.getMember('target');
        if (!targetMember) return interaction.editReply("❌ Target member not found in this guild.");
        try {
            await targetMember.timeout(null);
            return interaction.editReply(`🔊 Active timeout has been lifted from <@${targetMember.id}>.`);
        } catch (err) {
            return interaction.editReply(`❌ Failed to remove timeout: ${err.message}`);
        }
    }

    if (commandName === 'say') {
        if (!member.permissions.has(PermissionFlagsBits.ManageMessages)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        await channel.send(options.getString('text'));
        return interaction.editReply("Broadcast sent.");
    }

    if (commandName === 'verification-panel') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        const panelEmbed = new EmbedBuilder().setTitle("Link Account").setDescription("Click **Link** below to hook your profile up.").setColor(0x355eed);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('panel_link_btn').setLabel('Link Roblox').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('panel_update_btn').setLabel('Update').setStyle(ButtonStyle.Secondary)
        );
        await channel.send({ embeds: [panelEmbed], components: [row] });
        return interaction.editReply("Deployed.");
    }

    if (commandName === 'verify') {
        const targetUser = options.getUser('target');

        // STRICT ACCESS CONTROL CHECK: Only admins can specify a target other than themselves
        if (targetUser && targetUser.id !== interaction.user.id && !member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: "❌ Access Denied: You are not an Administrator. You are only allowed to verify your own account.", flags: [MessageFlags.Ephemeral] });
        }

        const wait = checkCooldown(interaction.user.id, commandName, 5);
        if (wait) return interaction.reply({ content: `⏳ Cooldown active: ${wait}s`, flags: [MessageFlags.Ephemeral] });
        
        await interaction.deferReply();
        const activeTarget = targetUser || interaction.user;

        return await runVerificationProcess(interaction, options.getString('username'), activeTarget);
    }

    if (commandName === 'setup-group') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply();
        if (!data.groups) data.groups = {};
        data.groups[guildId] = options.getString('groupid');
        saveData();
        return interaction.editReply("✅ Group linked successfully.");
    }

    if (commandName === 'sync-group-roles') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
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
        const targetUser = options.getUser('user') || interaction.user;

        if (targetUser.id !== interaction.user.id && !member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.editReply("❌ You do not have permission to force rank updates on other members.");
        }

        return await runUpdateProcess(interaction, targetUser);
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

    if (commandName === 'giveaway') {
        return interaction.reply({ content: "🎉 Giveaway system processing backend configurations...", flags: [MessageFlags.Ephemeral] });
    }

    if (commandName === 'tickets') {
        return interaction.reply({ content: "🎫 Ticket integration pipeline loading...", flags: [MessageFlags.Ephemeral] });
    }
});

client.login(process.env.BOT_TOKEN);
