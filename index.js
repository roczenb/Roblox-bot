const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const mongoose = require('mongoose');
const axios = require('axios');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages] });

// Database Schemas
const UserSchema = new mongoose.Schema({ discordId: { type: String, required: true, unique: true }, robloxId: { type: String, required: true } });
const VerifiedUser = mongoose.model('VerifiedUser', UserSchema);

const GuildGroupSchema = new mongoose.Schema({ guildId: { type: String, required: true, unique: true }, groupId: { type: String, required: true } });
const GuildGroup = mongoose.model('GuildGroup', GuildGroupSchema);

const BindSchema = new mongoose.Schema({ guildId: { type: String, required: true }, groupId: { type: String, required: true }, rankId: { type: Number, required: true }, roleId: { type: String, required: true } });
const RoleBind = mongoose.model('RoleBind', BindSchema);

const commands = [
    new SlashCommandBuilder().setName('verify').setDescription('Link your Roblox account').addStringOption(o => o.setName('username').setDescription('Roblox Username').setRequired(true)),
    new SlashCommandBuilder().setName('setup-group').setDescription('Link your Roblox Group ID').addStringOption(o => o.setName('groupid').setDescription('Group ID').setRequired(true)),
    new SlashCommandBuilder().setName('sync-group-roles').setDescription('Admin Only: Automatically create and bind Discord roles for every Roblox group rank'),
    new SlashCommandBuilder().setName('bind').setDescription('Bind rank to role').addIntegerOption(o => o.setName('rankid').setDescription('Rank (1-255)').setRequired(true)).addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)),
    new SlashCommandBuilder().setName('update').setDescription('Sync your ranks')
].map(c => c.toJSON());

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    
    // Fixed Database Connection Block
    if (process.env.MONGO_URL) {
        try {
            await mongoose.connect(process.env.MONGO_URL);
            console.log("Connected seamlessly to MongoDB Database.");
        } catch (dbErr) {
            console.error("DATABASE ERROR: Bot running without DB features.", dbErr.message);
        }
    } else {
        console.log("NO MONGO_URL DETECTED. Operating in standalone mode.");
    }

    const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('Successfully reloaded application (/) commands globally.');
    } catch (e) { console.error("COMMAND DEPLOY ERROR:", e.message); }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, options, guildId, member } = interaction;

    if (commandName === 'verify') {
        await interaction.deferReply();
        try {
            const res = await axios.post('https://users.roproxy.com/v1/usernames/users', { usernames: [options.getString('username')], excludeBannedUsers: true });
            if (!res.data.data.length) return interaction.editReply("❌
