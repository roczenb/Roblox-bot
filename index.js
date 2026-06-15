const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const mongoose = require('mongoose');
const axios = require('axios');

// 1. Initialize Client with proper Intents
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages
    ]
});

// 2. Database Schemas (Updated to remember a server's main group)
const UserSchema = new mongoose.Schema({
    discordId: { type: String, required: true, unique: true },
    robloxId: { type: String, required: true }
});
const VerifiedUser = mongoose.model('VerifiedUser', UserSchema);

// Stores the main group configuration per server
const GuildGroupSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    groupId: { type: String, required: true }
});
const GuildGroup = mongoose.model('GuildGroup', GuildGroupSchema);

const BindSchema = new mongoose.Schema({
    guildId: { type: String, required: true },
    groupId: { type: String, required: true },
    rankId: { type: Number, required: true }, 
    roleId: { type: String, required: true }
});
const RoleBind = mongoose.model('RoleBind', BindSchema);

// 3. Register Slash Commands (Updated options!)
const commands = [
    new SlashCommandBuilder()
        .setName('verify')
        .setDescription('Link your Roblox account using your username')
        .addStringOption(option => option.setName('username').setDescription('Your Roblox Username').setRequired(true)),
    
    new SlashCommandBuilder()
        .setName('setup-group')
        .setDescription('Admin Only: Link your main Roblox Group ID to this server')
        .addStringOption(option => option.setName('groupid').setDescription('Roblox Group ID').setRequired(true)),

    new SlashCommandBuilder()
        .setName('bind')
        .setDescription('Admin Only: Bind a rank to a role (Uses the group set via /setup-group)')
        .addIntegerOption(option => option.setName('rankid').setDescription('Rank number (1-255)').setRequired(true))
        .addRoleOption(option => option.setName('role').setDescription('Discord role to give').setRequired(true)),
        
    new SlashCommandBuilder()
        .setName('update')
        .setDescription('Sync your current Roblox ranks to your Discord roles')
].map(command => command.toJSON());

// 4. Client Ready Event
client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    
    if (process.env.MONGO_URL) {
        await mongoose.connect(process.env.MONGO_URL);
        console.log("Connected seamlessly to MongoDB Database.");
    } else {
        console.log("WARNING: MONGO_URL variable is missing. Database features will fail.");
    }

    const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('Successfully reloaded application (/) commands globally.');
    } catch (error) {
        console.error(error);
    }
});

// 5. Command Interactions
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, options, guildId, member } = interaction;

    // --- VERIFY COMMAND ---
    if (commandName === 'verify') {
        await interaction.deferReply();
        const username = options.getString('username');

        try {
            const robloxRes = await axios.post('https://users.roblox.com/v1/usernames/users', {
                usernames: [username],
                excludeBannedUsers: true
            });

            if (!robloxRes.data.data.length) {
                return interaction.editReply("❌ That Roblox username does not exist.");
            }

            const robloxId = robloxRes.data.data[0].id;

            await VerifiedUser.findOneAndUpdate(
                { discordId: interaction.user.id },
                { robloxId: robloxId },
                { upsert: true, new: true }
            );

            const embed = new EmbedBuilder()
                .setTitle("✅ Verification Successful")
                .setDescription(`Successfully linked **${username}** (${robloxId}) to your Discord account!\nRun \`/update\` to fetch your roles.`)
                .setColor(0x00FF00);

            return interaction.editReply({ embeds: [embed] });
        } catch (err) {
            console.error(err);
            return interaction.editReply("❌ Something went wrong while verifying.");
        }
    }

    // --- SETUP-GROUP COMMAND (ADMIN ONLY) ---
    if (commandName === 'setup-group') {
        if (!member.permissions.has('Administrator')) {
            return interaction.reply({ content: "❌ You must be an Administrator to run this.", ephemeral: true });
        }

        const groupId = options.getString('groupid');

        // Save or update the server's single main group
        await GuildGroup.findOneAndUpdate(
            { guildId: guildId },
            { groupId: groupId },
            { upsert: true, new: true }
        );

        return interaction.reply(`✅ **Group Linked!** This server is now tied to Roblox Group ID: \`${groupId}\`. You can now use \`/bind\` without typing the group ID.`);
    }

    // --- BIND COMMAND (ADMIN ONLY - AUTO USES LINKED GROUP) ---
    if (commandName === 'bind') {
        if (!member.permissions.has('Administrator')) {
            return interaction.reply({ content: "❌ You must be an Administrator to run this.", ephemeral: true });
        }

        // Look up the group previously saved for this specific server
        const guildConfig = await GuildGroup.findOne({ guildId: guildId });
        if (!guildConfig) {
            return interaction.reply({ content: "❌ Please run \`/setup-group\` first to link your Roblox Group to this server!", ephemeral: true });
        }

        const rankId = options.getInteger('rankid');
        const role = options.getRole('role');

        // Create the bind using the auto-fetched Group ID
        await RoleBind.create({
            guildId: guildId,
            groupId: guildConfig.groupId,
            rankId: rankId,
            roleId: role.id
        });

        return interaction.reply(`✅ Successfully bound Rank **${rankId}** (from Group ${guildConfig.groupId}) to role **${role.name}**!`);
    }

    // --- UPDATE COMMAND ---
    if (commandName === 'update') {
        await interaction.deferReply();

        const userData = await VerifiedUser.findOne({ discordId: interaction.user.id });
        if (!userData) {
            return interaction.editReply("❌ You are not verified yet. Run `/verify` first.");
        }

        try {
            const serverBinds = await RoleBind.find({ guildId: guildId });
            if (!serverBinds.length) {
                return interaction.editReply("❌ This server doesn't have any roles bound yet. Ask an admin to use `/bind`.");
            }

            let rolesAdded = [];
            let rolesRemoved = [];

            // Fetch user rank data once to use across the loop
            const groupRes = await axios.get(`https://groups.roblox.com/v2/users/${userData.robloxId}/groups/roles`);

            for (const bind of serverBinds) {
                const groupMatch = groupRes.data.data.find(g => g.group.id.toString() === bind.groupId);
                const currentRank = groupMatch ? groupMatch.role.rank : 0;
                const targetRole = interaction.guild.roles.cache.get(bind.roleId);

                if (targetRole) {
                    if (currentRank === bind.rankId) {
                        if (!member.roles.cache.has(targetRole.id)) {
                            await member.roles.add(targetRole);
                            rolesAdded.push(targetRole.name);
                        }
                    } else {
                        if (member.roles.cache.has(targetRole.id)) {
                            await member.roles.remove(targetRole);
                            rolesRemoved.push
client.login(process.env.BOT_TOKEN);
