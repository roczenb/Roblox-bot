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

// 2. Database Schemas (How the bot remembers data)
const UserSchema = new mongoose.Schema({
    discordId: { type: String, required: true, unique: true },
    robloxId: { type: String, required: true }
});
const VerifiedUser = mongoose.model('VerifiedUser', UserSchema);

const BindSchema = new mongoose.Schema({
    guildId: { type: String, required: true },
    groupId: { type: String, required: true },
    rankId: { type: Number, required: true }, // e.g., 1-255
    roleId: { type: String, required: true }
});
const RoleBind = mongoose.model('RoleBind', BindSchema);

// 3. Register Slash Commands
const commands = [
    new SlashCommandBuilder()
        .setName('verify')
        .setDescription('Link your Roblox account using your username')
        .addStringOption(option => option.setName('username').setDescription('Your Roblox Username').setRequired(true)),
    
    new SlashCommandBuilder()
        .setName('bind')
        .setDescription('Admin Only: Bind a Roblox rank to a Discord role')
        .addStringOption(option => option.setName('groupid').setDescription('Roblox Group ID').setRequired(true))
        .addIntegerOption(option => option.setName('rankid').setDescription('Rank number (1-255)').setRequired(true))
        .addRoleOption(option => option.setName('role').setDescription('Discord role to give').setRequired(true)),
        
    new SlashCommandBuilder()
        .setName('update')
        .setDescription('Sync your current Roblox ranks to your Discord roles')
].map(command => command.toJSON());

// 4. Client Ready Event
client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    
    // Connect to MongoDB using Railway environment variable
    if (process.env.MONGO_URL) {
        await mongoose.connect(process.env.MONGO_URL);
        console.log("Connected seamlessly to MongoDB Database.");
    } else {
        console.log("WARNING: MONGO_URL variable is missing. Database features will fail.");
    }

    // Deploy commands to Discord API
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
            // Fetch Roblox user ID from username
            const robloxRes = await axios.post('https://users.roblox.com/v1/usernames/users', {
                usernames: [username],
                excludeBannedUsers: true
            });

            if (!robloxRes.data.data.length) {
                return interaction.editReply("❌ That Roblox username does not exist.");
            }

            const robloxId = robloxRes.data.data[0].id;

            // Save relationship to the Database
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

    // --- BIND COMMAND (ADMIN ONLY) ---
    if (commandName === 'bind') {
        if (!member.permissions.has('Administrator')) {
            return interaction.reply({ content: "❌ You must be an Administrator to run this.", ephemeral: true });
        }

        const groupId = options.getString('groupid');
        const rankId = options.getInteger('rankid');
        const role = options.getRole('role');

        // Save bind setting to Database
        await RoleBind.create({
            guildId: guildId,
            groupId: groupId,
            rankId: rankId,
            roleId: role.id
        });

        return interaction.reply(`✅ Successfully bound Group **${groupId}** (Rank: ${rankId}) to role **${role.name}**!`);
    }

    // --- UPDATE COMMAND ---
    if (commandName === 'update') {
        await interaction.deferReply();

        // 1. Check if user is verified in DB
        const userData = await VerifiedUser.findOne({ discordId: interaction.user.id });
        if (!userData) {
            return interaction.editReply("❌ You are not verified yet. Run `/verify` first.");
        }

        try {
            // 2. Fetch all active binds for this Discord Server
            const serverBinds = await RoleBind.find({ guildId: guildId });
            if (!serverBinds.length) {
                return interaction.editReply("❌ This server doesn't have any roles bound yet. Ask an admin to use `/bind`.");
            }

            let rolesAdded = [];
            let rolesRemoved = [];

            // 3. Process binds loop
            for (const bind of serverBinds) {
                // Fetch user rank in specific Roblox group
                const groupRes = await axios.get(`https://groups.roblox.com/v2/users/${userData.robloxId}/groups/roles`);
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
                            rolesRemoved.push(targetRole.name);
                        }
                    }
                }
            }

            return interaction.editReply(`🔄 **Roles Updated!**\n**Added:** ${rolesAdded.join(', ') || 'None'}\n**Removed:** ${rolesRemoved.join(', ') || 'None'}`);

        } catch (err) {
            console.error(err);
            return interaction.editReply("❌ Network error updating your ranks.");
        }
    }
});

// 6. Automatically update users when joining server
client.on('guildMemberAdd', async (member) => {
    const userData = await VerifiedUser.findOne({ discordId: member.id });
    if (!userData) return; // Not verified, do nothing

    const serverBinds = await RoleBind.find({ guildId: member.guild.id });
    
    for (const bind of serverBinds) {
        try {
            const groupRes = await axios.get(`https://groups.roblox.com/v2/users/${userData.robloxId}/groups/roles`);
            const groupMatch = groupRes.data.data.find(g => g.group.id.toString() === bind.groupId);
            const currentRank = groupMatch ? groupMatch.role.rank : 0;
            const targetRole = member.guild.roles.cache.get(bind.roleId);

            if (targetRole && currentRank === bind.rankId) {
                await member.roles.add(targetRole);
            }
        } catch (e) {
            console.error("Auto-role fail on join: ", e.message);
        }
    }
});

client.login(process.env.BOT_TOKEN);
