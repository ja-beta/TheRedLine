const functions = require('firebase-functions/v2');
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const { GoogleGenerativeAI } = require('@google/generative-ai');


admin.initializeApp();

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


exports.fetchNews = functions.https.onRequest(async (req, res) => {
  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_STUDIO_API_KEY);
  const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash", 
  tuningModel: "tunedModels/rtl-prompt-fs6ygs462rbt"
});

  const API_KEY = process.env.NEWSCATCHER_API_KEY;
  let pendingScoreUpdates = 0;
  const BATCH_THRESHOLD = 5;

  if (!API_KEY) {
    console.error("NewsCatcher API key is missing.");
    res.status(500).send("Internal Server Error: API key is missing.");
    return;
  }

  const url = 'https://api.newscatcherapi.com/v2/latest_headlines?lang=en&when=1d&page_size=100&topic=news';

  const options = {
    method: 'GET',
    headers: {
      'x-api-key': API_KEY,
    },
  };

  try {

    console.log("Fetching latest headlines from NewsCatcher API...");
    const response = await fetch(url, options);
    if (!response.ok) {
      console.error(`NewsCatcher API request failed. Status: ${response.status}`);
      throw new Error(`API request failed with status ${response.status}`);
    }

    const result = await response.json();
    console.log("NewsCatcher API response:", result);

    const filteredArticles = result.articles.filter(article => {
      const summary = article.summary.toLowerCase();
      const matches = summary.includes('israel') || summary.includes('israeli');
      if (matches) {
        console.log(`Article matches criteria: ${article.title}`);
      }
      return matches;
    });
    console.log("Filtered articles:", filteredArticles);

    if (filteredArticles.length === 0) {
      console.warn("No articles found that match the criteria.");
      res.status(200).send({ message: "No articles matching the criteria." });
      return;
    }

    const ref = admin.database().ref('news-01');

    const writePromises = filteredArticles.map(async (article) => {
      const existingArticleSnapshot = await ref.orderByChild('title').equalTo(article.title).once('value');
      if (existingArticleSnapshot.exists()) {
        console.log(`Article "${article.title}" already exists. Skipping...`);
        return;
      }

      try {
        const score = await askGemini(article.summary, model);
        console.log(`Gemini score for article "${article.title}": ${score}`);

        const articleRef = await ref.push({
          title: article.title,
          summary: article.summary,
          link: article.link,
          timestamp: Date.now(),
          score: score,
        });

        console.log(`New article created with key: ${articleRef.key}`);

        pendingScoreUpdates++;

        if (pendingScoreUpdates >= BATCH_THRESHOLD) {
          await calculateAndDisplayWeightedAverage();
          pendingScoreUpdates = 0;
        }

      } catch (error) {
        console.error(`Error processing article "${article.title}":`, error);

        const articleRef = await ref.push({
          title: article.title,
          summary: article.summary,
          link: article.link,
          timestamp: Date.now(),
          score: "pending",
        });
      }

    });

    await Promise.all(writePromises);
    if (pendingScoreUpdates > 0) {
      await calculateAndDisplayWeightedAverage();
      pendingScoreUpdates = 0;
    }
    console.log("All new articles written to Firebase successfully.");
    res.status(200).send({ message: "Articles stored successfully." });

  } catch (error) {
    console.error("Error in fetchNews function:", error.message);
    res.status(500).send("Internal Server Error");
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
  const newsRef = admin.database().ref('news-01');
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
  const newsRef = admin.database().ref('news-01');
  const snapshot = await newsRef.once('value');
  const articles = snapshot.val();
  const keys = Object.keys(articles || {});
  const currentTime = Date.now();
  let totalWeightedScore = 0;
  let totalWeight = 0;

  const decayConstant = 14 * 24 * 60 * 60 * 1000;  // 2 weeks (its days * hrs * mins * secs * ms)

  keys.forEach((key) => {
    const article = articles[key];
    const articleTime = article.timestamp;
    const timeDifference = currentTime - articleTime;
    const weight = Math.exp(-timeDifference / decayConstant);

    if (article.score !== "pending") {
      totalWeightedScore += article.score * weight;
      totalWeight += weight;
    }
  });

  const weightedAverage = totalWeight === 0 ? 0 : totalWeightedScore / totalWeight;
  console.log(`Calculated weighted average score: ${weightedAverage}`);
  await updateMainScore(weightedAverage);
}

async function updateMainScore(weightedAverage) {
  const mainScoreRef = admin.database().ref('mainScore');
  await mainScoreRef.set({ score: weightedAverage });
  console.log("Main score updated successfully.");

  // if (client.connected) {
  //   const scoreMessage = JSON.stringify({ score: weightedAverage });
  //   client.publish(MQTT_TOPIC, scoreMessage, { qos: 1 }, (err) => {
  //     if (err) {
  //       console.error('Failed to publish message:', err);
  //     } else {
  //       console.log(`Published score to MQTT topic "${MQTT_TOPIC}":`, scoreMessage);
  //     }
  //   });
  // }
}



//#region  MQTT ___________________________________________________________________

// const mqtt = require('mqtt');
// // const MQTT_BROKER_URL = "theredline.cloud.shiftr.io"; //this worked
// const MQTT_BROKER_URL = "mqtt://theredline.cloud.shiftr.io";
// const MQTT_USERNAME = "theredline";
// const MQTT_PASSWORD = "thisisit";
// const MQTT_TOPIC = "mainScore";

// const client = mqtt.connect(MQTT_BROKER_URL, {
//   username: MQTT_USERNAME,
//   password: MQTT_PASSWORD
// });

// client.on('connect', () => {
//   console.log('Connected to MQTT broker');
//   client.subscribe(MQTT_TOPIC, { qos: 1 }, (err) => {
//     if (err) console.error('Failed to subscribe to topic:', err);
//   });
// });

// client.on('error', (err) => {
//   console.error('MQTT error:', err);
// });

//#endregion