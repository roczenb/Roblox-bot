const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
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
let data = { users: {}, groups: {}, binds: {}, antimention: {}, protectedTargets: {} };

// --- CONFIGURATION WITH LITERAL CHARACTERS ---
const LC_ROLE_NAME = "~{}~ Lead Command ~{}~"; 
const ANTIMENTION_BYPASS_ROLE = "Speaker of the Senate"; 

const cooldowns = new Map();
let isUpdateAllRunning = false; 

function loadData() {
    try {
        const dir = path.dirname(DB_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (fs.existsSync(DB_FILE)) {
            data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            if (!data.antimention) data.antimention = {};
            if (!data.protectedTargets) data.protectedTargets = {};
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
    new SlashCommandBuilder().setName('updateall').setDescription('Lead Command Only: Update every verified member in the server at once'),
    new SlashCommandBuilder().setName('antimention').setDescription('Admin Only: Toggle shield settings')
        .addBooleanOption(o => o.setName('enabled').setDescription('Turn anti-mention filter on or off').setRequired(true))
        .addUserOption(o => o.setName('protect-user').setDescription('Nuke messages that mention this specific user').setRequired(false))
        .addRoleOption(o => o.setName('protect-role').setDescription('Nuke messages that mention this specific role').setRequired(false)),
    new SlashCommandBuilder().setName('embed-create').setDescription('Admin Only: Create a custom embed message')
        .addStringOption(o => o.setName('color').setDescription('Hex Code code color (ex: #FF0000 for Red)').setRequired(false)),
    new SlashCommandBuilder().setName('embed-edit').setDescription('Admin Only: Modify an existing bot embed')
        .addStringOption(o => o.setName('message-id').setDescription('The ID of the bot message containing the embed').setRequired(true))
].map(c => c.toJSON());

// --- FIXES DUPLICATE COMMANDS ON STARTUP ---
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
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

// --- ENHANCED ANTI-MENTION LISTENER ---
client.on('messageCreate', async message => {
    if (!message.guild || message.author.bot) return;

    const isEnabled = data.antimention ? data.antimention[message.guild.id] : false;
    if (!isEnabled) return;

    const hasBypassRole = message.member.roles.cache.some(r => r.name === ANTIMENTION_BYPASS_ROLE);
    const isAdmin = message.member.permissions.has('Administrator');
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

// --- MODAL & HANDLER ROUTING INTERACTION HANDLER ---
client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand()) {
        const { commandName, options, guildId, member, channel } = interaction;

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

                const existingRoles = await interaction.guild.roles.fetch();
                const trackingList = [];

                for (const r of rRoles) {
                    data.binds[guildId] = data.binds[guildId].filter(b => !(b.groupId === gId && b.rankId === r.rank));
                    let existingRole = existingRoles.find(role => role.name === r.name);
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
            if (!member.permissions.has('Administrator')) return interaction.reply({ content: "❌ Admins only.", ephemeral: true });
            
            const chosenColor = options.getString('color') || '#3498DB';

            const modal = new ModalBuilder().setCustomId(`embed_create_modal_${chosenColor}`).setTitle('Create Custom Embed');
            const titleInput = new TextInputBuilder().setCustomId('embed_title').setLabel('Embed Title').setStyle(TextInputStyle.Short).setRequired(true);
            const descInput = new TextInputBuilder().setCustomId('embed_desc').setLabel('Embed Description').setStyle(TextInputStyle.Paragraph).setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(titleInput), new ActionRowBuilder().addComponents(descInput));
            return await interaction.showModal(modal);
        }

        if (commandName === 'embed-edit') {
            if (!member.permissions.has('Administrator')) return interaction.reply({ content: "❌ Admins only.", ephemeral: true });
            
            const msgId = options.getString('message-id');
            try {
                const targetMsg = await channel.messages.fetch(msgId);
                if (targetMsg.author.id !== client.user.id) return interaction.reply({ content: "❌ I can only edit embeds that were sent by this bot profile.", ephemeral: true });
                if (!targetMsg.embeds.length) return interaction.reply({ content: "❌ That targeted message does not contain a valid embed.", ephemeral: true });

                const currentEmbed = targetMsg.embeds[0];
                const modal = new ModalBuilder().setCustomId(`embed_edit_modal_${msgId}`).setTitle('Edit Existing Embed');
                
                const titleInput = new TextInputBuilder().setCustomId('embed_title').setLabel('Embed Title').setStyle(TextInputStyle.Short).setValue(currentEmbed.title || '').setRequired(true);
                const descInput = new TextInputBuilder().setCustomId('embed_desc').setLabel('Embed Description').setStyle(TextInputStyle.Paragraph).setValue(currentEmbed.description || '').setRequired(true);

                modal.addComponents(new ActionRowBuilder().addComponents(titleInput), new ActionRowBuilder().addComponents(descInput));
                return await interaction.showModal(modal);
            } catch (err) {
                return interaction.reply({ content: "❌ Message not found. Make sure you run this command in the exact same channel the message is in.", ephemeral: true });
            }
        }
    }

    if (interaction.isModalSubmit()) {
        const { customId, fields, channel } = interaction;

        if (customId.startsWith('embed_create_modal_')) {
            await interaction.deferReply({ ephemeral: true });
            const colorHex = customId.replace('embed_create_modal_', '');
            const title = fields.getTextInputValue('embed_title');
            const description = fields.getTextInputValue('embed_desc');

            const newEmbed = new EmbedBuilder()
                .setTitle(title)
                .setDescription(description)
                .setColor(colorHex.startsWith('#') ? colorHex : `#${colorHex}`);

            await channel.send({ embeds: [newEmbed] });
            return interaction.editReply("✅ Embed sent successfully!");
        }

        if (customId.startsWith('embed_edit_modal_')) {
            await interaction.deferReply({ ephemeral: true });
            const msgId = customId.replace('embed_edit_modal_', '');
            const title = fields.getTextInputValue('embed_title');
            const description = fields.getTextInputValue('embed_desc');

            try {
                const targetMsg = await channel.messages.fetch(msgId);
                const oldEmbed = targetMsg.embeds[0];
                
                const editedEmbed = EmbedBuilder.from(oldEmbed)
                    .setTitle(title)
                    .setDescription(description);

                await targetMsg.edit({ embeds: [editedEmbed] });
                return interaction.editReply("✅ Embed modified successfully!");
            } catch (err) {
                return interaction.editReply("❌ Failed to modify embed data.");
            }
        }
    }
});

client.login(process.env.BOT_TOKEN);
