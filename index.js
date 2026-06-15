const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const mongoose = require('mongoose');
const axios = require('axios');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages] });

const DB = {
    User: mongoose.model('U', new mongoose.Schema({ discordId: String, robloxId: String })),
    Group: mongoose.model('G', new mongoose.Schema({ guildId: String, groupId: String })),
    Bind: mongoose.model('B', new mongoose.Schema({ guildId: String, groupId: String, rankId: Number, roleId: String }))
};

const commands = [
    new SlashCommandBuilder().setName('verify').setDescription('Link Roblox').addStringOption(o => o.setName('username').setDescription('Username').setRequired(true)),
    new SlashCommandBuilder().setName('setup-group').setDescription('Link Group ID').addStringOption(o => o.setName('groupid').setDescription('Group ID').setRequired(true)),
    new SlashCommandBuilder().setName('sync-group-roles').setDescription('Auto create all group roles'),
    new SlashCommandBuilder().setName('bind').setDescription('Bind rank').addIntegerOption(o => o.setName('rankid').setDescription('Rank').setRequired(true)).addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)),
    new SlashCommandBuilder().setName('update').setDescription('Sync ranks')
].map(c => c.toJSON());

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    // Fallback connection string if your Railway variable fails
    const fallbackURI = "mongodb+srv://publicBotUser:BotPass123!@cluster0.whv9s.mongodb.net/robloxBot?retryWrites=true&w=majority";
    const connectionString = process.env.MONGO_URL || fallbackURI;
    
    await mongoose.connect(connectionString)
        .then(() => console.log("DB Online"))
        .catch(e => console.log("DB Offline fallback error: ", e.message));

    try {
        await new REST({ version: '10' }).setToken(process.env.BOT_TOKEN).put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('Commands deployed!');
    } catch (e) { console.error(e); }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, options, guildId, member } = interaction;

    if (commandName === 'verify') {
        await interaction.deferReply();
        try {
            const res = await axios.post('https://users.roproxy.com/v1/usernames/users', { usernames: [options.getString('username')], excludeBannedUsers: true });
            if (!res.data.data.length) return interaction.editReply("❌ User not found.");
            const rId = res.data.data[0].id;
            await DB.User.findOneAndUpdate({
