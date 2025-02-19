const functions = require('firebase-functions/v2');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const mqtt = require('mqtt');

const NEWS_COLLECTION = 'news-02';  

admin.initializeApp();

async function initializeConfigIfNeeded() {
  const configRef = admin.database().ref('config');
  const snapshot = await configRef.once('value');
  if (!snapshot.exists()) {
    await configRef.set({
      newsFetching: {
        enabled: true,
        intervalMinutes: 2,
        lastFetchTime: 0
      }
    });
  }
}

exports.compareModels = functions.https.onRequest(async (req, res) => {
  try {
    console.log("Starting model comparison test...");

    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_STUDIO_API_KEY);

    const tunedModel = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      tuningModel: "tunedModels/rtl-prompt-fs6ygs462rbt"
    });

    const baseModel = genAI.getGenerativeModel({
      model: "gemini-1.5-flash"
    });

    const testCases = [
      "Peace talks between Israeli and Palestinian leaders show promising progress with both sides agreeing to humanitarian measures.",
      "Violent clashes erupted at the border, resulting in casualties on both sides.",
      "New economic cooperation agreement signed between Israeli and Palestinian businesses.",
      "Protests against the ongoing conflict continue to grow in major cities.",
      "Joint Israeli-Palestinian youth education program launches in Jerusalem."
    ];

    const results = [];

    for (const testCase of testCases) {
      const prompt = `Please provide a sentiment analysis score for the article summary added below. When calculating the score, consider the greater good of people living in the geographic region known as Israel / Palestine and the impact that's described in the text could have over their future. The score must be a floating point number between 0 and 1 (0 is negative sentiment and 1 is positive sentiment) with up to 6 decimal places. The answer should only contain the number, no additional characters, spaces, or line breaks.

Summary: ${testCase}`;

      const tunedResult = await tunedModel.generateContent(prompt);
      const baseResult = await baseModel.generateContent(prompt);

      const tunedResponse = tunedResult.response.text().trim();
      const baseResponse = baseResult.response.text().trim();

      results.push({
        summary: testCase,
        tunedModel: {
          response: tunedResponse,
          parsedScore: parseFloat(tunedResponse)
        },
        baseModel: {
          response: baseResponse,
          parsedScore: parseFloat(baseResponse)
        }
      });
    }

    res.status(200).json({
      success: true,
      modelInfo: {
        tunedModel: "tunedModels/rtl-prompt-fs6ygs462rbt",
        baseModel: "gemini-1.5-flash"
      },
      results: results,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error("Error comparing models:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

exports.scheduledNewsFetch = onSchedule('every 2 minutes', async (context) => {
  try {
    // Check config
    const configRef = admin.database().ref('config/newsFetching');
    const config = (await configRef.once('value')).val();

    if (!config.enabled) {
      console.log('News fetching is disabled');
      return null;
    }

    // Initialize AI 
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_STUDIO_API_KEY);
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      tuningModel: "tunedModels/rtl-prompt-fs6ygs462rbt"
    });

    let pendingScoreUpdates = 0;
    const BATCH_THRESHOLD = 1;

    // Get unprocessed articles
    const newsRef = admin.database().ref(NEWS_COLLECTION);
    const snapshot = await newsRef.orderByChild('processed')
                                 .equalTo('pending')
                                 .once('value');
    const unprocessedArticles = snapshot.val() || {};
    
    console.log(`Found ${Object.keys(unprocessedArticles).length} pending articles`);

    if (Object.keys(unprocessedArticles).length === 0) {
      console.log('No new articles to process');
      await configRef.update({ lastFetchTime: Date.now() });
      return null;
    }

    // Process articles
    const writePromises = Object.entries(unprocessedArticles).map(async ([key, article]) => {
      const existingArticleSnapshot = await newsRef.orderByChild('title').equalTo(article.title).once('value');
      if (existingArticleSnapshot.exists()) {
        console.log('Found matches:', JSON.stringify(existingArticleSnapshot.val(), null, 2));
      }
      
      const matches = existingArticleSnapshot.val() || {};
      const isDuplicate = Object.keys(matches).some(matchKey => matchKey !== key);
      
      if (isDuplicate) {
        console.log(`Article "${article.title}" already exists in a different entry. Skipping...`);
        await newsRef.child(key).update({ 
          processed: 'duplicate'
        });
        return;
      }

      try {
        const score = await askGemini(article.summary, model);
        console.log(`Gemini score for article "${article.title}": ${score}`);

        await newsRef.child(key).update({
          processed: 'complete',
          score: score
        });

        console.log(`Updated article ${key} with score`);
        pendingScoreUpdates++;

        if (pendingScoreUpdates >= BATCH_THRESHOLD) {
          await calculateAndDisplayWeightedAverage();
          pendingScoreUpdates = 0;
        }

      } catch (error) {
        console.error(`Error processing article "${article.title}":`, error);
        await newsRef.child(key).update({ 
          processed: 'error',
          error: error.message 
        });
      }
    });

    await Promise.all(writePromises);

    if (pendingScoreUpdates > 0) {
      await calculateAndDisplayWeightedAverage();
    }

    await retryPendingScores();
    await configRef.update({ lastFetchTime: Date.now() });
    console.log("News fetch completed successfully");
    return null;

  } catch (error) {
    console.error('Error in scheduled news fetch:', error);
    return null;
  }
});

exports.updateNewsFetchingConfig = functions.https.onRequest(async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ success: false, error: 'Method not allowed' });
      return;
    }

    const configRef = admin.database().ref('config/newsFetching');
    const { enabled, intervalMinutes } = req.body;

    const updates = {};
    if (enabled !== undefined) updates.enabled = enabled;
    if (intervalMinutes !== undefined && intervalMinutes >= 1) {
      updates.intervalMinutes = intervalMinutes;
    }

    await configRef.update(updates);
    const updatedConfig = (await configRef.once('value')).val();

    console.log('Config updated:', updatedConfig);
    res.status(200).json({
      success: true,
      config: updatedConfig
    });

  } catch (error) {
    console.error('Error updating config:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

exports.getNewsFetchingConfig = functions.https.onRequest(async (req, res) => {
  try {
    if (req.method !== 'GET') {
      res.status(405).json({ success: false, error: 'Method not allowed' });
      return;
    }

    const configRef = admin.database().ref('config/newsFetching');
    const config = (await configRef.once('value')).val();

    console.log('Current config:', config);
    res.status(200).json({
      success: true,
      config: config
    });

  } catch (error) {
    console.error('Error getting config:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

exports.initializeConfig = functions.https.onRequest(async (req, res) => {
  try {
    const configRef = admin.database().ref('config/newsFetching');
    const snapshot = await configRef.once('value');

    if (!snapshot.exists()) {
      await configRef.set({
        enabled: true,
        intervalMinutes: 2,
        lastFetchTime: 0
      });
      console.log('Config initialized with default values');
    }

    const currentConfig = (await configRef.once('value')).val();
    res.status(200).json({
      success: true,
      message: 'Config initialized',
      config: currentConfig
    });
  } catch (error) {
    console.error('Error initializing config:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

async function askGemini(summary, model) {
  try {
    const prompt = `Please provide a sentiment analysis score for the article summary added below. When calculating the score, consider the greater good of people living in the geographic region known as Israel / Palestine and the impact that's described in the text could have over their future. The score must be a floating point number between 0 and 1 (0 is negative sentiment and 1 is positive sentiment) with up to 6 decimal places. The answer should only contain the number, no additional characters, spaces, or line breaks.
    Summary: ${summary}`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const rawResponse = response.text().trim();

    console.log(`Raw Gemini response for article: ${rawResponse}`);

    const score = parseFloat(rawResponse);

    if (isNaN(score) || score < 0 || score > 1) {
      throw new Error(`Invalid score format received: ${rawResponse}`);
    }

    console.log(`Processed score: ${score}`);
    return Number(score.toFixed(6));

  } catch (error) {
    console.error("Error in askGemini:", error);
    throw new Error(`Failed to get valid score: ${error.message}`);
  }
}

async function retryPendingScores() {
  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_STUDIO_API_KEY);
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    tuningModel: "tunedModels/rtl-prompt-fs6ygs462rbt"
  });
  
  const newsRef = admin.database().ref(NEWS_COLLECTION);
  const snapshot = await newsRef.orderByChild('score').equalTo('pending').once('value');
  const pendingArticles = snapshot.val();

  if (!pendingArticles) {
    console.log('No pending articles found');
    return;
  }

  console.log(`Found ${Object.keys(pendingArticles).length} pending articles`);

  for (const [key, article] of Object.entries(pendingArticles)) {
    try {
      console.log(`Processing pending article: ${article.title}`);
      const score = await askGemini(article.summary, model);
      await newsRef.child(key).update({ score: score });
      console.log(`Updated score for article ${key}: ${score}`);
    } catch (error) {
      console.error(`Failed to update pending score for article ${key}:`, error);
    }
  }

  await calculateAndDisplayWeightedAverage();
}

async function calculateAndDisplayWeightedAverage() {
  const newsRef = admin.database().ref(NEWS_COLLECTION);
  const snapshot = await newsRef.once('value');
  const articles = snapshot.val();
  const keys = Object.keys(articles || {});
  const currentTime = Date.now();
  let totalWeightedScore = 0;
  let totalWeight = 0;

  const decayConstant = 1 * 10 * 60 * 60 * 1000;  // (its days * hrs * mins * secs * ms)

  console.log('Calculating weighted average for articles:', JSON.stringify(articles, null, 2));

  keys.forEach((key) => {
    const article = articles[key];
    if (typeof article.score !== 'number' || !article.timestamp) {
      console.log(`Skipping article ${key} - invalid score or timestamp`);
      return;
    }

    const articleTime = article.timestamp;
    const timeDifference = currentTime - articleTime;
    const weight = Math.exp(-timeDifference / decayConstant);

    console.log(`Article ${key}: score=${article.score}, weight=${weight}`);
    
    totalWeightedScore += article.score * weight;
    totalWeight += weight;
  });

  if (totalWeight === 0) {
    console.log('No valid articles found for weighted average');
    return;
  }

  const weightedAverage = totalWeight === 0 ? 0 : totalWeightedScore / totalWeight;
  
  if (isNaN(weightedAverage)) {
    console.error('Calculated weighted average is NaN - skipping update');
    return;
  }

  console.log(`Calculated weighted average score: ${weightedAverage}`);
  await updateMainScore(weightedAverage);
}

async function updateMainScore(weightedAverage) {
  const mainScoreRef = admin.database().ref('mainScore');
  await mainScoreRef.set({ score: weightedAverage });
  console.log("Main score updated successfully.");

  if (client.connected) {
    const scoreMessage = JSON.stringify({ score: weightedAverage });
    client.publish(MQTT_TOPIC, scoreMessage, { qos: 1 }, (err) => {
      if (err) {
        console.error('Failed to publish message:', err);
      } else {
        console.log(`Published score to MQTT topic "${MQTT_TOPIC}":`, scoreMessage);
      }
    });
  }
}

// MQTT Configuration
// const MQTT_BROKER_URL = "theredline.cloud.shiftr.io"; //this worked
const MQTT_BROKER_URL = "mqtt://theredline.cloud.shiftr.io";
const MQTT_USERNAME = "theredline";
const MQTT_PASSWORD = "thisisit";
const MQTT_TOPIC = "mainScore";

let lastPublishedScore = null;
const PUBLISH_THRESHOLD = 0.000001;

const client = mqtt.connect(MQTT_BROKER_URL, {
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD
});

const mainScoreRef = admin.database().ref('mainScore');
mainScoreRef.on('value', (snapshot) => {
  const score = snapshot.val()?.score || 0;
  console.log(`Score changed in Firebase: ${score}`);

  if (lastPublishedScore === null || Math.abs(score - lastPublishedScore) > PUBLISH_THRESHOLD) {

    if (client.connected) {
      const scoreMessage = JSON.stringify({ score: score });
      client.publish(MQTT_TOPIC, scoreMessage, { qos: 1, retain: true }, (err) => {
        if (err) {
          console.error('Failed to publish message:', err);
        } else {
          lastPublishedScore = score;
          console.log(`Published score to MQTT topic "${MQTT_TOPIC}":`, scoreMessage);
        }
      });
    }
  }
});

client.on('connect', () => {
  console.log('Connected to MQTT broker');
});

client.on('error', (err) => {
  console.error('MQTT error:', err);
});//#endregion
