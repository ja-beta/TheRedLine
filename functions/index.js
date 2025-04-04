const functions = require('firebase-functions/v2');
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const mqtt = require('mqtt');
const path = require('path');


let firebaseConfig = {};
try {
  if (process.env.FIREBASE_CONFIG) {
    firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
  }
} catch (e) {
  console.error('Error parsing FIREBASE_CONFIG:', e);
}

const COLLECTION = 
  (process.env.DB_COLLECTION) || 
  (firebaseConfig.db && firebaseConfig.db.collection) ||
  'news-03';
const INTERVAL_MINUTES = parseInt(
  process.env.INTERVAL_MINUTES || 
  (firebaseConfig.interval && firebaseConfig.interval.minutes) || 
  '10', 10);
const GEMINI_API_KEY = 
  process.env.GOOGLE_AI_STUDIO_API_KEY ||
  (firebaseConfig.gemini && firebaseConfig.gemini.api_key);

console.log(`Using collection: ${COLLECTION}`);

const serviceAccount = require(path.join(__dirname, 'creds.json'));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://theredline-jn-default-rtdb.firebaseio.com'
});



async function initializeConfigIfNeeded() {
  const configRef = admin.database().ref('config');
  const snapshot = await configRef.once('value');
  if (!snapshot.exists()) {
    await configRef.set({
      newsFetching: {
        enabled: true,
        intervalMinutes: 10,
        lastFetchTime: 0
      }
    });
  }
}

// exports.compareModels = functions.https.onRequest(async (req, res) => {
//   try {
//     console.log("Starting model comparison test...");

//     const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_STUDIO_API_KEY);

//     const tunedModel = genAI.getGenerativeModel({
//       model: "gemini-1.5-flash",
//       tuningModel: "tunedModels/rtl-prompt-fs6ygs462rbt"
//     });

//     const baseModel = genAI.getGenerativeModel({
//       model: "gemini-1.5-flash"
//     });

//     const testCases = [
//       "Peace talks between Israeli and Palestinian leaders show promising progress with both sides agreeing to humanitarian measures.",
//       "Violent clashes erupted at the border, resulting in casualties on both sides.",
//       "New economic cooperation agreement signed between Israeli and Palestinian businesses.",
//       "Protests against the ongoing conflict continue to grow in major cities.",
//       "Joint Israeli-Palestinian youth education program launches in Jerusalem."
//     ];

//     const results = [];

//     for (const testCase of testCases) {
//       const prompt = `Please provide a sentiment analysis score for the article summary added below. When calculating the score, consider the greater good of people living in the geographic region known as Israel / Palestine and the impact that's described in the text could have over their future. The score must be a floating point number between 0 and 1 (0 is negative sentiment and 1 is positive sentiment) with up to 6 decimal places. The answer should only contain the number, no additional characters, spaces, or line breaks.

// Summary: ${testCase}`;

//       const tunedResult = await tunedModel.generateContent(prompt);
//       const baseResult = await baseModel.generateContent(prompt);

//       const tunedResponse = tunedResult.response.text().trim();
//       const baseResponse = baseResult.response.text().trim();

//       results.push({
//         summary: testCase,
//         tunedModel: {
//           response: tunedResponse,
//           parsedScore: parseFloat(tunedResponse)
//         },
//         baseModel: {
//           response: baseResponse,
//           parsedScore: parseFloat(baseResponse)
//         }
//       });
//     }

//     return {
//       success: true,
//       modelInfo: {
//         tunedModel: "tunedModels/rtl-prompt-fs6ygs462rbt",
//         baseModel: "gemini-1.5-flash"
//       },
//       results: results,
//       timestamp: new Date().toISOString()
//     };

//   } catch (error) {
//     console.error("Error comparing models:", error);
//     throw new functions.https.HttpsError('internal', error.message);
//   }
// });

exports.scheduledNewsFetch = functions.https.onRequest(async (req, res) => {
  try {
    const configRef = admin.database().ref('config/newsFetching');
    const config = (await configRef.once('value')).val();

    if (!config.enabled) {
      console.log('News fetching is disabled');
      res.status(200).json({ success: true, message: 'News fetching is disabled' });
      return;
    }

    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      tuningModel: "tunedModels/rtl-prompt-fs6ygs462rbt",
      temperature: 0.7,
      topP: 0.9
    });

    let pendingScoreUpdates = 0;
    const BATCH_THRESHOLD = 1;

    console.log(`Looking for pending articles in collection: ${COLLECTION}`);
    
    const newsRef = admin.database().ref(COLLECTION);
    
    const allArticles = await newsRef.once('value');
    console.log(`Total articles in database: ${Object.keys(allArticles.val() || {}).length}`);
    
    const snapshot = await newsRef.orderByChild('processed')
                             .equalTo('pending')
                             .once('value');
                             
    const unprocessedArticles = snapshot.val() || {};
    console.log(`Found ${Object.keys(unprocessedArticles).length} pending articles`);

    if (Object.keys(unprocessedArticles).length === 0) {
      console.log('No pending articles found');
      await calculateMainScore();
      res.status(200).json({ success: true, message: 'News fetch completed successfully' });
      return;
    }

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
        console.log(`Sending summary to Gemini: Summary Content: ${article.content}`);
        const score = await askGemini(article.content, model);
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
    res.status(200).json({ success: true, message: 'News fetch completed' });

  } catch (error) {
    console.error('Error in scheduled news fetch:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

exports.updateNewsFetchingConfig = functions.https.onRequest(async (req, res) => {
  try {
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
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

exports.getNewsFetchingConfig = functions.https.onRequest(async (req, res) => {
  try {
    const configRef = admin.database().ref('config/newsFetching');
    const config = (await configRef.once('value')).val();

    console.log('Current config:', config);
    res.status(200).json({
      success: true,
      config: config
    });

  } catch (error) {
    console.error('Error getting config:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
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
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

exports.healthCheck = functions.https.onRequest((req, res) => {
  res.status(200).send('OK');
});

async function askGemini(summary, model) {
  try {
    const prompt = `Please provide an analysis score for the article summary added below. When calculating the score, consider the greater good of people living in the geographic region known as Israel / Palestine and the impact that's described in the text could have over their future. The score must be a floating point number between 0 and 1 (0 is extremely negative impact and 1 is extremely positive impact) with up to 6 decimal places. The answer should only contain the number, no additional characters, spaces, or line breaks.
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
    tuningModel: "tunedModels/rtl-prompt-fs6ygs462rbt",
    temperature: 0.7,
    topP: 0.9
  });
  
  const newsRef = admin.database().ref(COLLECTION);
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
      const score = await askGemini(article.content, model);
      await newsRef.child(key).update({ score: score });
      console.log(`Updated score for article ${key}: ${score}`);
    } catch (error) {
      console.error(`Failed to update pending score for article ${key}:`, error);
    }
  }

  await calculateAndDisplayWeightedAverage();
}

async function calculateAndDisplayWeightedAverage() {
  const newsRef = admin.database().ref(COLLECTION);
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
});


//this is triggered by the scraper.py script! 
exports.triggerNewsFetch = functions.https.onRequest(async (req, res) => {
  try {
    const configRef = admin.database().ref('config/newsFetching');
    const config = (await configRef.once('value')).val();

    if (!config.enabled) {
      console.log('News fetching is disabled');
      res.status(200).json({ success: true, message: 'News fetching is disabled' });
      return;
    }

    
    res.status(200).json({ 
      success: true, 
      message: 'News fetch completed successfully' 
    });

  } catch (error) {
    console.error('Error in manual news fetch:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

exports.processNewArticle = functions.database.onValueCreated(
  `/${COLLECTION}/{articleId}`,
  async (event) => {
    try {
      const articleId = event.params.articleId;
      const article = event.data.val();
      
      console.log(`New article detected: "${article.title || 'Untitled'}"`);
      
      if (!article || article.processed !== 'pending') {
        console.log('Article is not pending, skipping processing');
        return null;
      }
      
      const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({
        model: "gemini-1.5-flash",
        tuningModel: "tunedModels/rtl-prompt-fs6ygs462rbt",
        temperature: 0.7,
        topP: 0.9
      });
      
      console.log(`Processing article: "${article.title}"`);
      
      try {
        console.log(`Sending content to Gemini: Content length: ${article.content?.length || 0}`);
        const score = await askGemini(article.content, model);
        console.log(`Gemini score for article: ${score}`);
        
        await admin.database().ref(`${COLLECTION}/${articleId}`).update({
          processed: 'complete',
          score: score
        });
        
        console.log(`Updated article ${articleId} with score: ${score}`);
        
        await calculateMainScore();
        
        return null;
      } catch (error) {
        console.error(`Error processing article: ${error.message}`);
        await admin.database().ref(`${COLLECTION}/${articleId}`).update({
          processed: 'error',
          error: error.message
        });
        return null;
      }
    } catch (error) {
      console.error('Error in processNewArticle:', error);
      return null;
    }
  }
);


async function calculateMainScore() {
  try {
    console.log('Calculating main score...');
    
    const mainScoreRef = admin.database().ref('mainScore');
    const newsRef = admin.database().ref(COLLECTION);
    
    // Get all processed articles with scores
    const snapshot = await newsRef
      .orderByChild('processed')
      .equalTo('complete')
      .once('value');
    
    const scoredArticles = snapshot.val() || {};
    
    if (Object.keys(scoredArticles).length === 0) {
      console.log('No scored articles found, keeping existing score');
      return;
    }
    
    let totalWeight = 0;
    let weightedSum = 0;
    
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000; 
    
    Object.entries(scoredArticles).forEach(([key, article]) => {
      const age = now - article.timestamp;
      const daysSinceAdded = age / oneDay;
      
      // Decay weight based on age
      const weight = Math.exp(-0.1 * daysSinceAdded);
      
      console.log(`Article ${key}: score=${article.score}, weight=${weight}`);
      
      weightedSum += article.score * weight;
      totalWeight += weight;
    });
    
    let averageScore = totalWeight > 0 ? weightedSum / totalWeight : 0.5;
    averageScore = Math.max(0, Math.min(1, averageScore)); // Clamp between 0 and 1
    
    console.log(`Calculated weighted average score: ${averageScore}`);
    
    await mainScoreRef.set({
      score: averageScore,
      lastUpdated: now
    });
    
    console.log('Main score updated successfully.');
  } catch (error) {
    console.error('Error calculating main score:', error);
  }
}

//#endregion
