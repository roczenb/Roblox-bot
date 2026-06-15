const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js');
const axios = require('axios');

// Create the Discord Client
const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] 
});

// Define the Slash Command
const commands = [
    new SlashCommandBuilder()
        .setName('update')
        .setDescription('Syncs your profile with any Roblox group rank')
        .addStringOption(option => 
            option.setName('username')
                .setDescription('The Roblox Username')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('group_id')
                .setDescription('The ID of the Roblox Group')
                .setRequired(true))
].map(command => command.toJSON());

// When the bot boots up
client.once('clientReady', async () => {
    console.log(`Logged in safely as ${client.user.tag}!`);
    
    // Register the slash commands globally on Discord
    const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
    try {
        console.log('Refreshing infinite-group commands...');
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('--- INFINITE-GROUP BOT IS LIVE ---');
    } catch (error) {
        console.error('Error registering slash commands:', error);
    }
});

// Handle the interaction command
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'update') {
        const username = interaction.options.getString('username');
        const groupIdInput = interaction.options.getString('group_id').trim();
        
        // Convert the input string into a number
        const targetGroupId = parseInt(groupIdInput, 10);

        await interaction.deferReply();

        // Safety check to ensure they entered a valid number for the Group ID
        if (isNaN(targetGroupId)) {
            return interaction.editReply('❌ Please enter a valid number for the Group ID!');
        }

        try {
            // 1. Resolve Roblox Username to User ID
            const userResponse = await axios.post('https://users.roblox.com/v1/usernames/users', { 
                usernames: [username], 
                excludeBannedUsers: false 
            });
            
            if (!userResponse.data.data || userResponse.data.data.length === 0) {
                return interaction.editReply(`❌ User "${username}" not found on Roblox.`);
            }
            
            const userId = userResponse.data.data[0].id;
            const actualName = userResponse.data.data[0].name;

            // 2. Fetch all groups the user is in
            const groupResponse = await axios.get(`https://groups.roblox.com/v1/users/${userId}/groups/roles`);
            const targetedGroup = groupResponse.data.data.find(g => g.group.id === targetGroupId);

            let rankName = "Non-Member", rankId = 0, groupName = `Group #${targetGroupId}`;
            if (targetedGroup) { 
                rankName = targetedGroup.role.name; 
                rankId = targetedGroup.role.rank; 
                groupName = targetedGroup.group.name;
            }

            // 3. Grab Avatar Thumbnail
            const thumbResponse = await axios.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=180x180&format=Png&isCircular=false`);
            const avatarUrl = thumbResponse.data.data[0]?.imageUrl || '';

            // 4. Build the profile embed card
            const embed = new EmbedBuilder()
                .setColor(targetedGroup ? '#00FF7F' : '#FF4500')
                .setTitle(`🔄 Group Sync: ${actualName}`)
                .setDescription(`Checked against group: **${groupName}**`)
                .addFields(
                    { name: 'Group Rank Name', value: `${rankName}`, inline: true }, 
                    { name: 'Rank Level (0-255)', value: `${rankId}`, inline: true }
                )
                .setThumbnail(avatarUrl)
                .setFooter({ text: `ID: ${targetGroupId}` })
                .setTimestamp();

            // 5. Attempt to update Discord Nickname
            try { 
                if (interaction.member.id !== interaction.guild.ownerId) {
                    await interaction.member.setNickname(`[${rankName}] ${actualName}`); 
                }
            } catch (err) {}

            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error(error);
            await interaction.editReply('❌ Error communicating with Roblox. Make sure that Group ID actually exists!');
        }
    }
});

// Login to Discord using the environment variable hidden safely on Railway
client.login(process.env.BOT_TOKEN);
