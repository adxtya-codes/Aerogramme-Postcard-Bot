const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const OpenAI = require('openai');
const Stripe = require('stripe');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Initialize clients
const client = new Client({
    authStrategy: new LocalAuth()
});

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// User session storage
const userSessions = new Map();

// Bot startup timestamp to ignore previous messages
let botStartTime = null;

// Conversation states
const STATES = {
    WELCOME: 'welcome',
    LANGUAGE_SELECTION: 'language_selection',
    NAME_COLLECTION: 'name_collection',
    ADDRESS_COLLECTION: 'address_collection',
    ADDRESS_CONFIRMATION: 'address_confirmation',
    MESSAGE_COLLECTION: 'message_collection',
    IMAGE_COLLECTION: 'image_collection',
    CONFIRMATION: 'confirmation',
    PAYMENT: 'payment',
    COMPLETED: 'completed',
    ANOTHER_POSTCARD: 'another_postcard',
    FAREWELL: 'farewell'
};

// Pre-defined messages (will be translated by AI)
const MESSAGES = {
    welcome: "👋 Welcome to Aerogramme! In which language would you like to continue? \n\n👋 Bienvenue sur Aerogramme ! Dans quelle langue souhaitez-vous continuer? \n\n👋 ¡Bienvenido a Aerogramme! ¿En qué idioma te gustaría continuar? \n\n👋 एरोग्राम में आपका स्वागत है! आप किस भाषा में जारी रखना चाहेंगे? \n\n👋 Aerogrammeへようこそ！どの言語で続けたいですか？",
    languageChange: "1️⃣ Press \"1\" for English\n2️⃣ Envoyez \"2\" pour Français\n3️⃣ Envía \"3\" para Español\n4️⃣ भेजें \"4\" हिंदी के लिए\n5️⃣ 日本語の場合は\"5\"を送信してください",
    greeting: "💌 Let's start from the beginning: who do you want to surprise? Give me the full name of the recipient (First + Last)!",
    nameConfirmation: "Great, I've noted that you want to send your postcard to {name}. 🏠 Now, give me their full address.\n\nPlease include: Street Number, Street Name, City, Postal Code, Country.\nFor example: 10 Avenue des Champs-Élysées, Paris, 75008, France",
    nameConfirmation_fr: "Parfait, j'ai noté que vous voulez envoyer votre carte postale à {name}. 🏠 Maintenant, donnez moi son adresse complète.\n\nPensez à renseigner: Numéro, Nom de Rue, Ville, Code Postal, Pays.\nPar exemple: 10 Avenue des Champs-Élysées, Paris, 75008, France",
    nameConfirmation_es: "Perfecto, he anotado que quieres enviar tu postal a {name}. 🏠 Ahora, dame su dirección completa.\n\nIncluye: Número de Calle, Nombre de Calle, Ciudad, Código Postal, País.\nPor ejemplo: 10 Avenue des Champs-Élysées, Paris, 75008, France",
    nameConfirmation_de: "Perfekt, ich habe notiert, dass Sie Ihre Postkarte an {name} senden möchten. 🏠 Geben Sie mir nun die vollständige Adresse.\n\nBitte angeben: Hausnummer, Straßenname, Stadt, Postleitzahl, Land.\nZum Beispiel: 10 Avenue des Champs-Élysées, Paris, 75008, France",
    messagePrompt: "Perfect, I've saved the address. Now, tell me the message you'd like to write on the back of your postcard. 📝",
    messageConfirmation: "Great, I've saved your message: « {message} ».",
    imagePrompt: "Now, send me the photo you want to use for your postcard. 📸",
    confirmation: "✅ Please confirm your details:\n👤 Recipient: {name}\n📍 Address: {address}\n📝 Message: {message}\n\nType 'Yes' to proceed ✅ or 'No' to make changes ✏️.", // English
    confirmation_fr: "✅ Veuillez confirmer vos informations :\n👤 Destinataire : {name}\n📍 Adresse : {address}\n📝 Message : {message}\n\nTapez 'Oui' pour continuer ✅ ou 'Non' pour apporter des modifications✏ .",
    paymentLink: "Great! Your order is confirmed. I'm preparing your payment link... 💳\nAwesome! All you need to do now is click here to complete payment 👉 {stripe_link}\nAnd that's it — your postcard will be sent within 24h once payment is received 🚀✉️",
    paymentSuccess: "🎉 Your postcard is on the way! Would you like to send another one?",
    editPrompt: "What would you like to edit?\n1️⃣ Name\n2️⃣ Address\n3️⃣ Message\n4️⃣ Image\n\nJust type the number or name of what you want to change."
};

// Initialize WhatsApp client
client.on('qr', (qr) => {
    console.log('QR Code received, scan please:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('WhatsApp client is ready!');
    // Set bot start time to ignore previous messages
    botStartTime = Date.now();
});

client.on('message', async (message) => {
    try {
        // Ignore messages sent before bot startup
        if (botStartTime && message.timestamp * 1000 < botStartTime) {
            return;
        }
        
        const userId = message.from;
        const messageText = message.body.trim();

        // Initialize user session if it doesn't exist
        if (!userSessions.has(userId)) {
            userSessions.set(userId, {
                started: false, // Only true after 'bonjour' is sent
                state: STATES.WELCOME,
                language: 'en',
                data: {},
                orderId: uuidv4(),
                addressCorrectionAttempts: 0,
                editingField: null,
                hasCompletedOrder: false,
                messageCount: 0,
                blocked: false,
                lastResetTime: Date.now(),
                manualAddressMode: false,
                wasEditingAddress: false,
                freeformAddressMode: false
            });
        }

        const session = userSessions.get(userId);

        // Enforce per-user 150-message limit (resets every 24 hours)
        const now = Date.now();
        const twentyFourHours = 24 * 60 * 60 * 1000;
        
        // Reset counter if 24 hours have passed
        if (!session.lastResetTime || (now - session.lastResetTime) >= twentyFourHours) {
            session.messageCount = 0;
            session.blocked = false;
            session.lastResetTime = now;
        }
        
        session.messageCount = (session.messageCount || 0) + 1;
        if (session.blocked || session.messageCount > 150) {
            if (!session.blocked) {
                const limitMsg = await translateMessage("You've reached the message limit for this chat (150 messages per 24 hours). Please try again tomorrow.", session.language || 'en');
                await client.sendMessage(message.from, limitMsg);
                session.blocked = true;
            }
            return;
        }

        // Require 'bonjour' trigger to start
        if (!session.started) {
            if (messageText.toLowerCase().includes('bonjour')) {
                session.started = true;
                // Start onboarding flow
                await handleWelcome(message, session);
            }
            // Ignore all other messages until trigger
            return;
        }

        await handleUserMessage(message, session, userId);

    } catch (error) {
        console.error('Error handling message:', error);
        await client.sendMessage(message.from, 'Sorry, something went wrong. Please try again.');
    }
});

async function handleUserMessage(message, session, userId) {
    const messageText = message.body.trim();
    
    // Check for special holiday promos (2 weeks before Christmas, New Year's, Valentine's)
    const today = new Date();
    const year = today.getFullYear();
    const holidays = [
        { key: 'christmas', date: new Date(year, 11, 25), prompt: 'Christmas is coming up in two weeks! Generate a festive, warm, encouraging message (with emojis) inviting the user to send a holiday postcard to loved ones via Aerogramme. The message must be in the user\'s chosen language: ' },
        { key: 'newyear', date: new Date(year + (today.getMonth() === 11 ? 1 : 0), 0, 1), prompt: 'New Year\'s Day is coming up in two weeks! Generate a cheerful, inspiring message (with emojis) inviting the user to send a New Year postcard to friends or family via Aerogramme. The message must be in the user\'s chosen language: ' },
        { key: 'valentine', date: new Date(year + (today.getMonth() > 1 ? 1 : 0), 1, 14), prompt: 'Valentine\'s Day is coming up in two weeks! Generate a loving, sweet message (with emojis) inviting the user to send a Valentine\'s postcard to someone special via Aerogramme. The message must be in the user\'s chosen language: ' }
    ];
    for (const holiday of holidays) {
        const msInDay = 24 * 60 * 60 * 1000;
        const daysBefore = Math.floor((holiday.date - today) / msInDay);
        if (daysBefore === 14 && (!session[`lastPromo${holiday.key}`] || session[`lastPromo${holiday.key}`] !== year)) {
            try {
                const promoCompletion = await openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [
                        {
                            role: "system",
                            content: `${holiday.prompt}${session.language ? session.language : 'English'}. Do NOT mention time or frequency. Not more than five lines. Return only the message text.`
                        }
                    ],
                    max_tokens: 100
                });
                const promoMsg = promoCompletion.choices[0].message.content.trim();
                await client.sendMessage(message.from, promoMsg);
                session[`lastPromo${holiday.key}`] = year;
            } catch (err) {}
        }
    }
    // Check and send promotional message every 5 weeks (35 days) (only after user has completed at least one order)
    const now = Date.now();
    if (session.hasCompletedOrder && (!session.lastPromoSent || (now - session.lastPromoSent) > 35 * 24 * 60 * 60 * 1000)) {
        try {
            let promoMsg = '';
            
            // Use specific promotional messages based on language
            switch (session.language) {
                case 'fr':
                    promoMsg = "Un petit mot qui fait grand plaisir : n'oubliez pas qu'une carte postale, ça touche toujours le cœur. Prenez un moment pour envoyer un sourire à ceux que vous aimez.";
                    break;
                case 'es':
                    promoMsg = "Una pequeña palabra que trae una gran alegría: no olvides que una postal siempre toca el corazón. Tómate un momento para enviar una sonrisa a quienes amas.";
                    break;
                default: // English and all other languages
                    promoMsg = "A little word that brings great pleasure: don't forget that a postcard always touches the heart. Take a moment to send a smile to those you love.";
                    break;
            }
            
            await client.sendMessage(message.from, promoMsg);
            session.lastPromoSent = now;
        } catch (err) {
            // If promo fails, continue as normal
        }
    }
    
    // Check for global commands first (restart/language) - but skip during welcome and language selection
    if (session.state !== STATES.WELCOME && session.state !== STATES.LANGUAGE_SELECTION) {
        const globalCommand = await detectGlobalCommand(messageText);
        
        if (globalCommand === 'restart') {
            // Reset state and data but keep language
            session.state = STATES.NAME_COLLECTION;
            session.data = {};
            session.orderId = uuidv4();
            session.addressCorrectionAttempts = 0;
            session.editingField = null;
            // Send greeting in user's language
            const greeting = await translateMessage(MESSAGES.greeting, session.language);
            await client.sendMessage(message.from, greeting);
            return;
        }
        
        if (globalCommand === 'language') {
            // Go back to language selection
            session.state = STATES.LANGUAGE_SELECTION;
            session.data = {};
            session.orderId = uuidv4();
            session.addressCorrectionAttempts = 0;
            session.editingField = null;
            session.editMode = false;
            
            // Send the numbered language change message
            await client.sendMessage(message.from, MESSAGES.languageChange);
            return;
        }
    }
    
    switch (session.state) {
        case STATES.WELCOME:
            await handleWelcome(message, session);
            break;
            
        case STATES.LANGUAGE_SELECTION:
            await handleLanguageSelection(message, session, messageText);
            break;
            
        case STATES.NAME_COLLECTION:
            await handleNameCollection(message, session, messageText);
            break;
            
        case STATES.ADDRESS_COLLECTION:
            await handleAddressCollection(message, session, messageText);
            break;
            
        case STATES.ADDRESS_CONFIRMATION:
            await handleAddressConfirmation(message, session, messageText);
            break;
            
        case STATES.MESSAGE_COLLECTION:
            await handleMessageCollection(message, session, messageText);
            break;
            
        case STATES.IMAGE_COLLECTION:
            await handleImageCollection(message, session);
            break;
            
        case STATES.CONFIRMATION:
            await handleConfirmation(message, session, messageText);
            break;
            
        case STATES.PAYMENT:
            await handlePayment(message, session, messageText);
            break;
            
        case STATES.COMPLETED:
            await handleCompleted(message, session);
            break;
            
        case STATES.ANOTHER_POSTCARD:
            await handleAnotherPostcard(message, session, messageText);
            break;
            
        case STATES.FAREWELL:
            await handleFarewell(message, session, messageText);
            break;
    }
}

async function handleWelcome(message, session) {
    // Send the original multilingual welcome message (not translated)
    await client.sendMessage(message.from, MESSAGES.welcome);
    session.state = STATES.LANGUAGE_SELECTION;
}

async function handleLanguageSelection(message, session, messageText) {
    // Detect language from user's response
    const detectedLanguage = await detectLanguage(messageText);
    session.language = detectedLanguage;
    
    // Send help message about restart and language commands
    const helpMsg = await translateMessage(
        'Please ask to "restart" if you want to restart our conversation any time 🔄 and "language" if you want to change the language. 😊',
        session.language
    );
    await client.sendMessage(message.from, helpMsg);
    
    // Send welcome message with language-specific image
    const welcomeMessage = await translateMessage(
        'Hello and welcome to Aerogramme. With me, you can send your postcards directly from WhatsApp. Here\'s what an Aerogramme postcard looks like once printed👇\n\nOn the front: your photo\nOn the back: your text (you can write a lot!)*\n\nThe price of a postcard is 4.49 euros. Each postcard will be sent in an envelope.',
        session.language
    );
    
    // Send welcome message first
    await client.sendMessage(message.from, welcomeMessage);
    
    // Then send language-specific image separately
    const imagePath = await getLanguageSpecificImage(session.language);
    if (imagePath) {
        try {
            const media = MessageMedia.fromFilePath(imagePath);
            await client.sendMessage(message.from, media);
        } catch (error) {
            console.error('Error sending image:', error);
        }
    }
    
    // Add 2-second buffer before sending the name collection prompt
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const greeting = await translateMessage(
        '💌Let\'s start from the beginning: who do you want to surprise? Give me the full name of the recipient (First + Last)!',
        session.language
    );
    await client.sendMessage(message.from, greeting);
    session.state = STATES.NAME_COLLECTION;
}

async function handleNameCollection(message, session, messageText) {
    // Capitalize the name properly
    const capitalizedName = capitalizeName(messageText);
    session.data.recipientName = capitalizedName;
    
    // If we're editing, return to confirmation
    if (session.editingField === 'name') {
        session.editingField = null;
        const updateMsg = await translateMessage(`✅ Updated recipient name to: ${capitalizedName}`, session.language);
        await client.sendMessage(message.from, updateMsg);
        await showConfirmation(message, session);
        return;
    }
    
    // Normal flow - continue to address collection
    // Use language-specific message if available, otherwise use default
    let messageKey = 'nameConfirmation';
    if (session.language === 'fr' && MESSAGES.nameConfirmation_fr) {
        messageKey = 'nameConfirmation_fr';
    } else if (session.language === 'es' && MESSAGES.nameConfirmation_es) {
        messageKey = 'nameConfirmation_es';
    } else if (session.language === 'de' && MESSAGES.nameConfirmation_de) {
        messageKey = 'nameConfirmation_de';
    }
    
    const confirmationMsg = await translateMessage(
        MESSAGES[messageKey].replace('{name}', capitalizedName), 
        session.language
    );
    await client.sendMessage(message.from, confirmationMsg);
    session.state = STATES.ADDRESS_COLLECTION;
}

async function handleAddressCollection(message, session, messageText) {
    // Check if user is in freeform address mode (when editing address with option 2)
    if (session.freeformAddressMode) {
        // User is editing address - accept exactly as typed, no AI formatting
        session.data.address = messageText; // Store exactly as user typed
        session.data.rawAddress = messageText; // Also store as raw
        session.freeformAddressMode = false; // Reset flag
        session.editingField = null;
        
        // Show update confirmation and return to main confirmation
        const updateMsg = await translateMessage(`✅ Updated address to: ${messageText}`, session.language);
        await client.sendMessage(message.from, updateMsg);
        await showConfirmation(message, session);
        return;
    }
    
    // Check if user is in manual address mode (after rejecting AI formatting)
    if (session.manualAddressMode) {
        // User manually adjusted address - format it again with AI and show for confirmation
        session.data.rawAddress = messageText; // Store the new manual input
        const formattedAddress = await formatAddressForConfirmation(messageText);
        session.data.aiFormattedAddress = formattedAddress; // Store new AI formatted version
        session.manualAddressMode = false; // Reset flag
        
        // Show the AI-corrected version again for confirmation (works for both editing and normal flow)
        await showAddressConfirmation(message, session);
        return;
    }
    
    // Stage 1: Accept address exactly as user types it
    session.data.rawAddress = messageText; // Store original input
    
    // Stage 2: Auto-format for confirmation with capitalization
    const formattedAddress = await formatAddressForConfirmation(messageText);
    session.data.aiFormattedAddress = formattedAddress; // Store AI formatted version
    
    // If we're editing, handle differently
    if (session.editingField === 'address') {
        session.wasEditingAddress = true; // Track that we were editing
        session.editingField = null;
        // Show AI formatted version and ask for confirmation
        await showAddressConfirmation(message, session);
        return;
    }
    
    // Normal flow - show AI formatted address and ask for confirmation
    await showAddressConfirmation(message, session);
}

// Show AI formatted address and ask for confirmation
async function showAddressConfirmation(message, session) {
    const confirmMsg = await translateMessage(
        `📍 I've formatted your address as:\n\n${session.data.aiFormattedAddress}\n\nType "Yes" to proceed or "No" to make changes`,
        session.language
    );
    await client.sendMessage(message.from, confirmMsg);
    session.state = STATES.ADDRESS_CONFIRMATION;
}

// Handle user's response to address confirmation
async function handleAddressConfirmation(message, session, messageText) {
    const yesNoIntent = await detectYesNoIntent(messageText);
    
    if (yesNoIntent === 'yes') {
        // User confirms AI formatted address
        session.data.address = session.data.aiFormattedAddress;
        
        // Check if we were editing - if so, return to confirmation
        if (session.wasEditingAddress) {
            session.wasEditingAddress = false; // Reset flag
            const updateMsg = await translateMessage(`✅ Updated address to: ${session.data.aiFormattedAddress}`, session.language);
            await client.sendMessage(message.from, updateMsg);
            await showConfirmation(message, session);
            return;
        }
        
        // Normal flow - continue to message collection
        const messagePrompt = await translateMessage(MESSAGES.messagePrompt, session.language);
        await client.sendMessage(message.from, messagePrompt);
        session.state = STATES.MESSAGE_COLLECTION;
        
    } else if (yesNoIntent === 'no') {
        // User wants to make changes - ask for manual adjustment
        const manualMsg = await translateMessage(
            `Please manually adjust your address and make your changes:`,
            session.language
        );
        await client.sendMessage(message.from, manualMsg);
        session.state = STATES.ADDRESS_COLLECTION;
        session.manualAddressMode = true;
        
    } else {
        // Invalid response - ask for clarification
        const clarifyMsg = await translateMessage(
            'Please respond with "Yes" to proceed or "No" to make changes',
            session.language
        );
        await client.sendMessage(message.from, clarifyMsg);
    }
}

async function handleMessageCollection(message, session, messageText) {
    console.log('Message received:', messageText); // Debug log
    session.data.message = messageText;
    console.log('Message stored in session:', session.data.message); // Debug log
    
    // If we're editing, return to confirmation
    if (session.editingField === 'message') {
        session.editingField = null;
        const translatedUpdate = await translateMessage(`✅ Updated message to: "{message}"`, session.language);
        const updateMsg = translatedUpdate.replace('{message}', messageText);
        await client.sendMessage(message.from, updateMsg);
        await showConfirmation(message, session);
        return;
    }
    
    // Normal flow - continue to image collection
    // Translate only the bot's confirmation text, keep user's message as-is
    const translatedConfirmation = await translateMessage(MESSAGES.messageConfirmation, session.language);
    const confirmationMsg = translatedConfirmation.replace('{message}', messageText);
    await client.sendMessage(message.from, confirmationMsg);
    
    const imagePrompt = await translateMessage(MESSAGES.imagePrompt, session.language);
    await client.sendMessage(message.from, imagePrompt);
    session.state = STATES.IMAGE_COLLECTION;
}

async function handleImageCollection(message, session) {
    if (message.hasMedia) {
        const media = await message.downloadMedia();
        session.data.imageUrl = `data:${media.mimetype};base64,${media.data}`;
        session.data.imageMedia = media; // Store the media object for resending
        
        // If we're editing, return to confirmation
        if (session.editingField === 'image') {
            session.editingField = null;
            const updateMsg = await translateMessage(`✅ Updated image for your postcard`, session.language);
            await client.sendMessage(message.from, updateMsg);
            await showConfirmation(message, session);
            return;
        }
        
        // Normal flow - show confirmation for the first time
        const confirmationMsg = await translateMessage(
            MESSAGES.confirmation
                .replace('{name}', session.data.recipientName)
                .replace('{address}', session.data.address)
                .replace('{message}', session.data.message),
            session.language
        );
        
        const imageMedia = new MessageMedia(media.mimetype, media.data);
        await client.sendMessage(message.from, imageMedia, { caption: confirmationMsg });
        session.state = STATES.CONFIRMATION;
    } else {
        const imagePrompt = await translateMessage(MESSAGES.imagePrompt, session.language);
        await client.sendMessage(message.from, imagePrompt);
    }
}

// Helper function to show confirmation with current data
async function showConfirmation(message, session) {
    console.log('Showing confirmation with message:', session.data.message); // Debug log
    // Translate only the bot's confirmation template, keep user data as-is
    const translatedConfirmation = await translateMessage(MESSAGES.confirmation, session.language);
    const confirmationMsg = translatedConfirmation
        .replace('{name}', session.data.recipientName)
        .replace('{address}', session.data.address)
        .replace('{message}', session.data.message || 'No message provided');
    
    if (session.data.imageMedia) {
        const imageMedia = new MessageMedia(session.data.imageMedia.mimetype, session.data.imageMedia.data);
        await client.sendMessage(message.from, imageMedia, { caption: confirmationMsg });
    } else {
        await client.sendMessage(message.from, confirmationMsg);
    }
    session.state = STATES.CONFIRMATION;
}

async function handleConfirmation(message, session, messageText) {
    const yesNoIntent = await detectYesNoIntent(messageText);
    
    if (yesNoIntent === 'yes' || messageText.includes('✅')) {
        // Generate Stripe payment link
        const paymentLink = await createStripePaymentLink(session, message.from);
        
        // Split payment message into two standalone messages with 6-second delay
        const paymentMsg1 = await translateMessage("Great! Your order is confirmed. I'm preparing your payment link... 💳", session.language);
        const paymentMsg2 = await translateMessage(
            `Awesome! All you need to do now is click here to complete payment 👉 ${paymentLink}\nAnd that's it — your postcard will be sent within 24h once payment is received 🚀✉️`,
            session.language
        );
        await client.sendMessage(message.from, paymentMsg1);
        
        // Wait 6 seconds before sending the payment link
        await new Promise(resolve => setTimeout(resolve, 6000));
        
        await client.sendMessage(message.from, paymentMsg2);
        session.state = STATES.PAYMENT;
        
    } else if (yesNoIntent === 'no' || messageText.includes('✏️')) {
        const editPrompt = await translateMessage(MESSAGES.editPrompt, session.language);
        await client.sendMessage(message.from, editPrompt);
        session.editMode = true;
        // Stay in confirmation state to handle edit selection
        
    } else if (session.editMode) {
        // Handle edit selection
        const choice = messageText.toLowerCase().trim();
        
        if (choice === '1' || choice.includes('name')) {
            const namePrompt = await translateMessage("Please enter the new recipient name:", session.language);
            await client.sendMessage(message.from, namePrompt);
            session.state = STATES.NAME_COLLECTION;
            session.editMode = false;
            session.editingField = 'name';
            
        } else if (choice === '2' || choice.includes('address')) {
            const addressPrompt = await translateMessage("Please enter the new address exactly as you want it to appear (no formatting will be applied):\n\nFor example: '10 Avenue des Champs-Élysées, Paris, 75008, France'", session.language);
            await client.sendMessage(message.from, addressPrompt);
            session.state = STATES.ADDRESS_COLLECTION;
            session.editMode = false;
            session.editingField = 'address';
            session.addressCorrectionAttempts = 0; // Reset counter when editing
            session.freeformAddressMode = true; // Enable freeform mode for editing
            
        } else if (choice === '3' || choice.includes('message')) {
            const messagePrompt = await translateMessage("Please enter the new message for the postcard:", session.language);
            await client.sendMessage(message.from, messagePrompt);
            session.state = STATES.MESSAGE_COLLECTION;
            session.editMode = false;
            session.editingField = 'message';
            
        } else if (choice === '4' || choice.includes('image')) {
            const imagePrompt = await translateMessage("Please send the new image for your postcard:", session.language);
            await client.sendMessage(message.from, imagePrompt);
            session.state = STATES.IMAGE_COLLECTION;
            session.editMode = false;
            session.editingField = 'image';
            
        } else {
            const invalidChoice = await translateMessage("Please select a valid option (1-4) or type the name of what you want to edit.", session.language);
            await client.sendMessage(message.from, invalidChoice);
        }
    } else {
        // Intent unclear - ask for clarification
        const clarificationMsg = await translateMessage(
            "I'm not sure if you want to proceed or make changes. Please type 'Yes' to proceed or 'No' to make changes. 😊",
            session.language
        );
        await client.sendMessage(message.from, clarificationMsg);
    }
}

async function handlePayment(message, session, messageText) {
    // Temporary testing bypass - remove in production
    if (messageText.toLowerCase() === 'donepay') {
        // Simulate successful payment
        await saveOrderToSheets(session);
        
        // Update payment status to paid
        try {
            await axios.put(`${process.env.SHEETBEST_API_URL}/order_id/${session.orderId}`, {
                payment_status: 'paid',
                payment_date: new Date().toISOString()
            });
        } catch (error) {
            console.log('Note: Could not update payment status in sheets (testing mode)');
        }
        
        // Split the success message into two distinct messages
        const congratsMsg = await translateMessage("Congratulations on successfully completing your payment! 🎉 Your postcard is on its way to making someone's day a little brighter.", session.language);
        const inspireMsg = await translateMessage("If you're inspired to send another heartfelt message, simply let us know, your next postcard awaits! 🖊️✨", session.language);
        await client.sendMessage(message.from, congratsMsg);
        await new Promise(resolve => setTimeout(resolve, 1500));
        await client.sendMessage(message.from, inspireMsg);
        session.state = STATES.ANOTHER_POSTCARD;
        session.hasCompletedOrder = true; // Mark that user has completed at least one order
        return;
    }
    
    // This will be handled by Stripe webhook
    const waitingMsg = await translateMessage(
        "Please complete your payment using the link above. I'll notify you once payment is confirmed! 💳\n\n(Testing: type 'donepay' to simulate payment)",
        session.language
    );
    await client.sendMessage(message.from, waitingMsg);
}

async function handleCompleted(message, session) {
    // This function is now only used for direct completion without asking for another postcard
    // Reset session for new order
    session.state = STATES.WELCOME;
    session.data = {};
    session.orderId = uuidv4();
    session.addressCorrectionAttempts = 0;
    session.editingField = null;
    
    await handleWelcome(message, session);
}

async function handleAnotherPostcard(message, session, messageText) {
    const intent = await detectUserIntent(messageText);
    
    if (intent === 'yes') {
        // User wants to send another postcard - skip language selection
        session.state = STATES.NAME_COLLECTION;
        session.data = {}; // Reset data but keep language and other session info
        session.orderId = uuidv4();
        session.addressCorrectionAttempts = 0;
        session.editingField = null;
        
        const greeting = await translateMessage(MESSAGES.greeting, session.language);
        await client.sendMessage(message.from, greeting);
        
    } else if (intent === 'no') {
        // User doesn't want to send another postcard
        const farewellMsg = await translateMessage(
            "Have a great day! You can come anytime if you want to send postcards to your loved ones! 💌",
            session.language
        );
        await client.sendMessage(message.from, farewellMsg);
        session.state = STATES.FAREWELL;
        
    } else {
        // Intent unclear - ask for clarification
        const clarificationMsg = await translateMessage(
            "I'm not sure if you'd like to send another postcard. Could you please say yes or no? 😊",
            session.language
        );
        await client.sendMessage(message.from, clarificationMsg);
        // Stay in same state
    }
}

async function handleFarewell(message, session, messageText) {
    // Any message after farewell takes them back to name collection (skipping language selection)
    session.state = STATES.NAME_COLLECTION;
    session.data = {}; // Reset data but keep language
    session.orderId = uuidv4();
    session.addressCorrectionAttempts = 0;
    session.editingField = null;
    
    const greeting = await translateMessage(MESSAGES.greeting, session.language);
    await client.sendMessage(message.from, greeting);
}


// AI function to generate dynamic "send another postcard" messages
async function generateDynamicPostcardMessage(language) {
    try {
        // Use the specific format requested by the user
        const baseMessage = "Congratulations on successfully completing your payment! 🎉 Your postcard is on its way to making someone's day a little brighter.\nIf you're inspired to send another heartfelt message, simply let us know, your next postcard awaits! 🖊️✨";
        
        // Translate to the user's language if not English
        if (language === 'en') {
            return baseMessage;
        } else {
            return await translateMessage(baseMessage, language);
        }
    } catch (error) {
        console.error('Dynamic message generation error:', error);
        return "🎉 Your postcard is on the way! Would you like to send another one?"; // Fallback
    }
}

// AI function to detect user intent (yes/no) for sending another postcard
async function detectUserIntent(text) {
    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "Analyze the user's message in ANY language to determine if they want to send another postcard. Return ONLY 'yes' if they want to send another postcard (words like yes, oui, sí, ja, はい, हाँ, sure, bien sûr, claro, klar, certo, okay, d'accord, vale, etc.), 'no' if they don't want to send another postcard (words like no, non, nein, いいえ, नहीं, not now, pas maintenant, ahora no, nicht jetzt, non ora, maybe later, peut-être plus tard, etc.), or 'unclear' if their intent is ambiguous. Work with all languages including English, French, Spanish, German, Italian, Hindi, Japanese, etc."
                },
                {
                    role: "user",
                    content: text
                }
            ],
            max_tokens: 10
        });
        
        const intent = completion.choices[0].message.content.trim().toLowerCase();
        return ['yes', 'no', 'unclear'].includes(intent) ? intent : 'unclear';
    } catch (error) {
        console.error('Intent detection error:', error);
        return 'unclear'; // Default to unclear if AI fails
    }
}

// AI function to detect global commands (restart/language)
async function detectGlobalCommand(text) {
    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "Analyze the user's message in ANY language to detect if they want to restart the bot or change language. Return ONLY 'restart' if they want to restart/reset the bot (words like restart, reset, recommencer, reiniciar, neustart, riavviare, etc.), 'language' if they want to change language (words like language, langue, idioma, sprache, lingua, etc.), or 'none' if neither. Work with all languages including English, French, Spanish, German, Italian, Hindi, Japanese, etc."
                },
                {
                    role: "user",
                    content: text
                }
            ],
            max_tokens: 10
        });
        
        const command = completion.choices[0].message.content.trim().toLowerCase();
        return ['restart', 'language', 'none'].includes(command) ? command : 'none';
    } catch (error) {
        console.error('Global command detection error:', error);
        return 'none'; // Default to none if AI fails
    }
}

// AI function to detect yes/no intent in any language
async function detectYesNoIntent(text) {
    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "Analyze the user's message in ANY language to detect their yes/no intent. Return ONLY 'yes' if they want to proceed/confirm (words like yes, oui, sí, ja, はい, हाँ, okay, d'accord, vale, confirm, confirmer, proceed, continue, etc.), 'no' if they want to make changes/edit (words like no, non, nein, いいえ, नहीं, edit, modifier, editar, change, changer, cambiar, modify, etc.), or 'unclear' if their intent is ambiguous. Work with all languages including English, French, Spanish, German, Italian, Hindi, Japanese, etc."
                },
                {
                    role: "user",
                    content: text
                }
            ],
            max_tokens: 10
        });
        
        const intent = completion.choices[0].message.content.trim().toLowerCase();
        return ['yes', 'no', 'unclear'].includes(intent) ? intent : 'unclear';
    } catch (error) {
        console.error('Yes/No intent detection error:', error);
        return 'unclear'; // Default to unclear if AI fails
    }
}

// AI Translation function
async function translateMessage(text, targetLanguage) {
    if (targetLanguage === 'en') return text;
    
    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: `Translate the following text to the language with code "${targetLanguage}". Keep emojis and formatting intact. Maintain the same tone and style. IMPORTANT: Always use formal language - use "vous" in French, "usted" in Spanish, and equivalent formal forms in all other languages. This is for professional customer service communication. Return only the translated text.`
                },
                {
                    role: "user",
                    content: text
                }
            ],
            max_tokens: 500
        });
        
        return completion.choices[0].message.content.trim();
    } catch (error) {
        console.error('Translation error:', error);
        return text; // Return original text if translation fails
    }
}

// Language detection function
async function detectLanguage(text) {
    // First check for numbered responses
    const trimmedText = text.trim();
    if (trimmedText === '1') return 'en';
    if (trimmedText === '2') return 'fr';
    if (trimmedText === '3') return 'es';
    if (trimmedText === '4') return 'hi';
    if (trimmedText === '5') return 'ja';
    
    // If not a number, use AI to detect language
    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "Detect the language of the following text. Return the ISO 639-1 language code (e.g., 'en' for English, 'fr' for French, 'es' for Spanish, 'hi' for Hindi, 'ja' for Japanese, 'de' for German, etc.). If you cannot detect the language or are unsure, return 'en' as default."
                },
                {
                    role: "user",
                    content: text
                }
            ],
            max_tokens: 10
        });
        
        const detectedLang = completion.choices[0].message.content.trim().toLowerCase();
        // Accept any valid language code, default to English if empty or invalid
        return detectedLang && detectedLang.length >= 2 ? detectedLang : 'en';
    } catch (error) {
        console.error('Language detection error:', error);
        return 'en'; // Default to English
    }
}

// Format address for confirmation display with capitalization and comma rules
async function formatAddressForConfirmation(address) {
    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: `Reformat this address into the structure: Street Number, Street Name, City, Postal Code, Country.
                    
                    Formatting Rules:
                    - Insert commas ONLY between non-empty segments
                    - DO NOT add empty commas (e.g., ", , , ,") - skip missing parts entirely
                    - Capitalize the FIRST LETTER of each word in street name, city, and country (Title Case)
                    - Keep postal code as provided (no changes) - treat state/province codes as part of postal code
                    - Handle Bis/Ter/Letters: Format as "29 Bis," or "29 Ter," or "29 A," (space + capital + comma after)
                    - If no country is provided, detect it from the postal code and add it
                    - For US/Canadian addresses: Keep state/province code with postal code (e.g., "NM 87505", "ON K1A 0A6")
                    - Do NOT change spelling, only formatting and capitalization
                    - Make sure EVERY word starts with a capital letter in street, city, and country
                    
                    Examples:
                    Input: "24 rue du General de Gaulle versailles sur orge 94782 france"
                    Output: "24, Rue Du General De Gaulle, Versailles Sur Orge, 94782, France"
                    
                    Input: "29bis avenue mozart paris 75016"
                    Output: "29 Bis, Avenue Mozart, Paris, 75016, France"
                    
                    Input: "10 avenue des champs-élysées france"
                    Output: "10, Avenue Des Champs-Élysées, France"
                    
                    Input: "1501 luisa ct santa fe nm 87505 états-unis"
                    Output: "1501, Luisa Ct, Santa Fe, NM 87505, États-Unis"
                    
                    Input: "123 main street toronto on m5v 3a8 canada"
                    Output: "123, Main Street, Toronto, ON M5V 3A8, Canada"
                    
                    Return only the formatted address, nothing else.`
                },
                {
                    role: "user",
                    content: address
                }
            ],
            max_tokens: 100
        });
        
        const formatted = completion.choices[0].message.content.trim();
        // Clean up any consecutive commas or commas with only spaces between them
        const cleaned = formatted.replace(/,(\s*,)+/g, ',').replace(/,\s*,/g, ',').trim();
        return cleaned;
    } catch (error) {
        console.error('Address formatting error:', error);
        // Fallback: simple capitalization and comma separation
        const words = address.trim().split(/\s+/);
        if (words.length >= 3) {
            // Handle case where country might be missing
            let country, postalCode, city, street;
            
            if (words.length >= 4) {
                // Check if we have a state/province code pattern (2 letters followed by postal code)
                const lastWord = words[words.length - 1];
                const secondLastWord = words[words.length - 2];
                const thirdLastWord = words[words.length - 3];
                
                // Check for US/Canadian pattern: state/province + postal code
                if (/^[A-Z]{2}$/i.test(secondLastWord) && (/^\d{5}(-\d{4})?$/i.test(lastWord) || /^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/i.test(lastWord))) {
                    // US/Canadian format: state/province code + postal code
                    country = words[words.length - 3] ? words.slice(-3, -2).join(' ') : 'United States';
                    postalCode = `${secondLastWord.toUpperCase()} ${lastWord.toUpperCase()}`;
                    city = words.slice(-5, -3).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
                    street = words.slice(0, -4).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
                    
                    // If the "country" looks like a city name, it's probably missing country
                    if (!/^(united|états|canada|usa)/i.test(country)) {
                        city = words.slice(-4, -2).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
                        street = words.slice(0, -3).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
                        country = 'United States'; // Default for state codes
                    } else {
                        country = country.charAt(0).toUpperCase() + country.slice(1).toLowerCase();
                    }
                } else {
                    // Standard format
                    country = words[words.length - 1].charAt(0).toUpperCase() + words[words.length - 1].slice(1).toLowerCase();
                    postalCode = words[words.length - 2];
                    city = words.slice(-4, -2).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
                    street = words.slice(0, -3).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
                }
            } else {
                // No country provided - detect from postal code (simple heuristic)
                postalCode = words[words.length - 1];
                city = words.slice(-3, -1).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
                street = words.slice(0, -2).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
                
                // Simple country detection based on postal code patterns
                if (/^\d{5}$/.test(postalCode)) {
                    country = 'France'; // French postal codes are 5 digits
                } else if (/^\d{4}$/.test(postalCode)) {
                    country = 'Belgium'; // Belgian postal codes are 4 digits
                } else {
                    country = 'France'; // Default fallback
                }
            }
            
            // Handle Bis/Ter formatting in street
            street = street.replace(/(\d+)(bis|ter|[a-z])(\s|,|$)/gi, (match, num, suffix, end) => {
                return `${num} ${suffix.charAt(0).toUpperCase() + suffix.slice(1).toLowerCase()}${end}`;
            });
            
            // Only join non-empty segments with commas
            return [street, city, postalCode, country].filter(Boolean).join(', ');
        }
        return address;
    }
}

// Google Sheets integration
async function saveOrderToSheets(session) {
    try {
        const orderData = {
            order_id: session.orderId,
            name: session.data.recipientName,
            address: session.data.address,
            message: session.data.message,
            image_status: session.data.imageUrl ? 'Image uploaded' : 'No image',
            timestamp: new Date().toISOString(),
            payment_status: 'pending'
        };
        
        console.log('Saving order data to sheets:', orderData); // Debug log
        await axios.post(process.env.SHEETBEST_API_URL, orderData);
        console.log('Order saved to Google Sheets:', session.orderId);
    } catch (error) {
        console.error('Error saving to Google Sheets:', error);
    }
}

// Stripe payment link creation
async function createStripePaymentLink(session, userId) {
    try {
        const paymentLink = await stripe.paymentLinks.create({
            line_items: [
                {
                    price_data: {
                        currency: process.env.CURRENCY || 'eur',
                        product_data: {
                            name: 'Aerogramme Postcard',
                            description: `Postcard for ${session.data.recipientName}`,
                        },
                        unit_amount: parseInt(process.env.POSTCARD_PRICE) || 500,
                    },
                    quantity: 1,
                },
            ],
            metadata: {
                order_id: session.orderId,
                user_id: userId,
                recipient_name: session.data.recipientName || '',
                address: session.data.address || '',
                message: session.data.message || ''
                // Note: Removed image_url as it exceeds Stripe's 500-character limit for metadata
            }
        });
        
        return paymentLink.url;
    } catch (error) {
        console.error('Error creating Stripe payment link:', error);
        return 'Payment link generation failed';
    }
}

// Stripe webhook handler (for external webhook endpoint)
async function handleStripeWebhook(event) {
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const orderId = session.metadata.order_id;
        
        // Update Google Sheets
        try {
            await axios.put(`${process.env.SHEETBEST_API_URL}/order_id/${orderId}`, {
                payment_status: 'paid',
                payment_date: new Date().toISOString()
            });
            
            console.log('Payment confirmed for order:', orderId);
            
            // Send success message to user (you'll need to store user phone numbers)
            // This would require additional logic to map order IDs to user sessions
            
        } catch (error) {
            console.error('Error updating payment status:', error);
        }
    }
}

// Helper function to capitalize names properly
function capitalizeName(name) {
    return name
        .trim()
        .split(/\s+/) // Split by any whitespace
        .map(word => {
            if (word.length === 0) return word;
            return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        })
        .join(' ');
}

// Helper function to get language-specific image path
async function getLanguageSpecificImage(languageCode) {
    const imagesDir = path.join(__dirname, 'images');
    const supportedExtensions = ['.jpg', '.jpeg', '.png', '.webp'];
    
    // Try to find image for specific language
    for (const ext of supportedExtensions) {
        const imagePath = path.join(imagesDir, `${languageCode}${ext}`);
        if (fs.existsSync(imagePath)) {
            return imagePath;
        }
    }
    
    // Fallback to English if specific language not found
    if (languageCode !== 'en') {
        for (const ext of supportedExtensions) {
            const fallbackPath = path.join(imagesDir, `en${ext}`);
            if (fs.existsSync(fallbackPath)) {
                return fallbackPath;
            }
        }
    }
    
    // No image found
    return null;
}

// Initialize the client
client.initialize();

console.log('Aerogramme WhatsApp Bot starting...');
