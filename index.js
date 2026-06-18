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
const { 
    joinVoiceChannel, 
    createAudioPlayer, 
    createAudioResource, 
    AudioPlayerStatus, 
    getVoiceConnection,
    StreamType
} = require('@discordjs/voice');
const googleTTS = require('google-tts-api');
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
        GatewayIntentBits.GuildVoiceStates
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

const LC_ROLE_NAME = "~{}~ Lead Command ~{}~"; 
const ANTIMENTION_BYPASS_ROLE = "Speaker of the Senate"; 

const cooldowns = new Map();
const guildInvitesCache = new Map();
const auditTracking = new Map();
let isUpdateAllRunning = false; 

const audioPlayers = new Map();

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
    new SlashCommandBuilder().setName('tickets').setDescription('Open or configuration process helper ticket pipelines'),
    new SlashCommandBuilder().setName('tss').setDescription('Verify terminal synchronization status systems'),
    new SlashCommandBuilder().setName('tts').setDescription('Send a standard text-to-speech announcement message').addStringOption(o => o.setName('message').setDescription('The content to speak aloud').setRequired(true)),
    new SlashCommandBuilder().setName('vc-disconnect').setDescription('Force disconnect the bot from the active voice channel connection')
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

client.on('channelDelete', channel => { if (channel.guild) incrementSecurityTrigger(channel.guild.id); });
client.on('roleDelete', role => { if (role.guild) incrementSecurityTrigger(role.guild.id); });

// --- AUTOMATED CHAT MONITORING ENGINE ---
client.on('messageCreate', async message => {
    if (!message.guild || message.author.bot) return;

    if (message.content.startsWith('?ban') || message.content.startsWith('?kick') || message.content.startsWith('?timeout')) {
        if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return;
        return message.channel.send(`⚙️ **[SYSTEM OPERATION EXECUTION]**: Target confirmation sequence acknowledged. Preparing background processing data packets...`);
    }

    // --- AUTOMATED VOICE TEXT-CHAT INTERACTIVE AUDIO STREAM ---
    const voiceChannel = message.member?.voice?.channel;
    const isVoiceChat = message.channel.isVoiceBased() || message.channel.type === ChannelType.GuildVoice;

    if (voiceChannel && (isVoiceChat || message.channel.id === voiceChannel.id)) {
        let connection = getVoiceConnection(message.guild.id);
        
        if (!connection || connection.joinConfig.channelId !== voiceChannel.id) {
            connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: message.guild.id,
                adapterCreator: message.guild.voiceAdapterCreator,
                selfMute: false,
                selfDeaf: false
            });
        }

        const speakerName = message.member.displayName || message.author.username;
        const cleanContent = message.content.replace(/(?:https?|ftp):\/\/[\n\S]+/g, '[link]'); 
        const speechText = `${speakerName} says: ${cleanContent}`.substring(0, 200);

        try {
            const url = googleTTS.getAudioUrl(speechText, {
                lang: 'en',
                slow: false,
                host: 'https://translate.google.com',
                timeout: 10000,
            });

            let player = audioPlayers.get(message.guild.id);
            if (!player) {
                player = createAudioPlayer();
                connection.subscribe(player);
                audioPlayers.set(message.guild.id, player);
            }

            const resource = createAudioResource(url, { inputType: StreamType.Arbitrary });
            player.play(resource);
        } catch (err) {
            console.error("Voice Auto-TTS Failure:", err.message);
        }
    }

    // --- ANTI-MENTION PROTECTION LAYER WITH REPLY HOOK EXEMPTION ---
    const isEnabled = data.antimention ? data.antimention[message.guild.id] : false;
    if (!isEnabled) return;

    const hasBypassRole = message.member.roles.cache.some(r => r.name === ANTIMENTION_BYPASS_ROLE);
    const isAdmin = message.member.permissions.has(PermissionFlagsBits.Administrator);
    if (isAdmin || hasBypassRole) return; 

    const totalMentions = message.mentions.users.size + message.mentions.roles.size;
    const targetConfig = data.protectedTargets ? data.protectedTargets[message.guild.id] : null;
    let triggeredProtection = false;
    let protectionReason = "";

    // If the message is a Reply, we bypass specific protected user checks so they can get pinged natively
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

    // Mass mentions are always blocked regardless of format if they cross the threshold
    if ((totalMentions > 4 && !isDiscordReply) || triggeredProtection) {
        if (!protectionReason) protectionReason = "mass mentions are restricted while the anti-mention shield is active";
        try {
            await message.delete();
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
    if (!interaction.isChatInputCommand()) return;
    const { commandName, options, guildId, member, channel, guild } = interaction;

    if (commandName === 'vc-disconnect') {
        const connection = getVoiceConnection(guild.id);
        if (!connection) return interaction.reply({ content: "❌ I am not sitting inside a voice channel.", flags: [MessageFlags.Ephemeral] });
        connection.destroy();
        audioPlayers.delete(guild.id);
        return interaction.reply("👋 Disconnected from voice chat.");
    }

    if (commandName === 'tts') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: "❌ Administrator validation required.", flags: [MessageFlags.Ephemeral] });
        }
        await channel.send({ content: options.getString('message'), tts: true });
        return interaction.reply({ content: "TTS sent.", flags: [MessageFlags.Ephemeral] });
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
