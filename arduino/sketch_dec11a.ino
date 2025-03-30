#include <TMC2209.h>
#include <ArduinoMqttClient.h>
#include <WiFiNINA.h>
#include "arduino_secrets.h"
#include <Adafruit_NeoPixel.h>

#define NEOPIN 9
#define NUMPIXELS 1

Adafruit_NeoPixel neop(NUMPIXELS, NEOPIN, NEO_GRB + NEO_KHZ800);

char ssid[] = SECRET_SSID;
char pass[] = SECRET_PASS;

char username[] = SECRET_BROKER_ID;
char password[] = SECRET_BROKER_PASS;

WiFiClient wifiClient;
MqttClient mqttClient(wifiClient);

const char broker[] = "theredline.cloud.shiftr.io";
const int port = 1883;
const char topic[] = "mainScore";
const String clientId = "Arduino-" + String(random(0xffff), HEX);
unsigned long lastConnectionCheck = 0;
const unsigned long CONNECTION_CHECK_INTERVAL = 5000;

const uint8_t STEP_PIN = 3;
const uint8_t DIR_PIN = 2;
const uint8_t ENABLE_PIN = 4;
const int hallSensor = 5;

const long TOTAL_STEPS = 1912300;  
long currentPosition = 0;
float targetScore = 0.0;
float currentScore = 0.0;
bool isMoving = false;
float queuedScore = -1;

const int MIN_DELAY = 55;
const int MAX_DELAY = 100;
const int RAMP_STEPS = 1000;


bool isHoming = false;
bool ledEnabled = false;
bool ledState = false;
unsigned long lastBlinkTime = 0;
const unsigned long BLINK_INTERVAL = 1000;
unsigned long blinkStartTime = 0;
const unsigned long BLINK_DURATION = 10000;

uint32_t redColor = neop.Color(255, 0, 0);
uint32_t idleColor = neop.Color(255, 85, 21);

unsigned long lastBreathTime = 0;
const unsigned long BREATH_INTERVAL = 30;
float breathBrightness = 0;
float breathDirection = 1;


void setup() {
  Serial.begin(9600);
  randomSeed(analogRead(0));

// remove this before final upload
  // while (!Serial) {
  //   delay(10);
  // }
  // Serial.println("starting...");

  delay(3000);

  // Hall sensor setup
  pinMode(hallSensor, INPUT_PULLUP);

  // Motor setup
  pinMode(STEP_PIN, OUTPUT);
  pinMode(DIR_PIN, OUTPUT);
  pinMode(ENABLE_PIN, OUTPUT);

  digitalWrite(ENABLE_PIN, LOW);

  // LED setup
  neop.begin();
  // neop.setBrightness(255);
  neop.show();
  delay(100);

  homePosition();
  delay(1000);

  // Network setup
  neop.setPixelColor(0, neop.Color(0, 240, 100));
  neop.show();

  Serial.print("Attempting to connect to WPA SSID: ");
  Serial.println(ssid);
  while (WiFi.begin(ssid, pass) != WL_CONNECTED) {
    Serial.print(".");
    delay(5000);
  }

  neop.setPixelColor(0, neop.Color(0, 255, 0));
  neop.show();

  Serial.println("You're connected to the network");
  Serial.println();

  //MQTT setup
  // mqttClient.setKeepAliveInterval(15 * 1000); // 15 seconds
  // mqttClient.setConnectionTimeout(10 * 1000); // 10 seconds
  mqttClient.setUsernamePassword(username, password);

  //  mqttClient.setCleanSession(true);


Serial.print("Attempting to connect to the MQTT broker: ");
  Serial.println(broker);

  if (!connectMQTT()) {
    Serial.println("MQTT connection failed! Error code = ");
    Serial.println(mqttClient.connectError());
    while (1) {
      neop.setPixelColor(0, neop.Color(200, 255, 0));
      neop.show();
      delay(500);
      neop.setPixelColor(0, neop.Color(0, 0, 0));
      neop.show();
      delay(500);
    }
  }

  Serial.println("You're connected to the MQTT broker!");
  Serial.println();

  Serial.println("Setting up MQTT subscriptions...");

  mqttClient.onMessage(onMqttMessage);

  Serial.print("Subscribing to topic: ");
  Serial.println(topic);
  Serial.println();

  mqttClient.subscribe(topic);

  Serial.print("Waiting for messages on topic: ");
  Serial.println(topic);
  Serial.println();

  // final setup
  turnPixOff();
  Serial.println("setup done");

}


void loop() {
  unsigned long currentMillis = millis();

  if (!isMoving && ledEnabled && (currentMillis - blinkStartTime >= BLINK_DURATION)) {
      ledEnabled = false;
      turnPixOff();
  }

  if (currentMillis - lastConnectionCheck >= CONNECTION_CHECK_INTERVAL){
    lastConnectionCheck = currentMillis;

    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("WiFi connection lost, reconnecting...");
      neop.setPixelColor(0, neop.Color(0, 0, 255)); 
      neop.show();
      
      int retries = 3;
      bool reconnected = false;
      
      while (retries > 0 && !reconnected) {
        Serial.print("WiFi reconnection attempt ");
        Serial.println(4 - retries);
        
        if (WiFi.begin(ssid, pass) == WL_CONNECTED) {
          Serial.println("Successfully reconnected to WiFi!");
          reconnected = true;
        } else {
          retries--;
          delay(1000);
        }
      }
      
      if (!reconnected) {
        Serial.println("Failed to reconnect to WiFi after multiple attempts");
      } else {
        turnPixOff(); 
      }
    }

    // Only check MQTT if WiFi is connected
    if (WiFi.status() == WL_CONNECTED && !mqttClient.connected()){
      Serial.println("MQTT connection lost, reconnecting...");
      
      if (connectMQTT()){
        Serial.println("Successfully reconnected to MQTT!");
        if(!mqttClient.subscribe(topic)) {
          Serial.println("Failed to subscribe to topic");
        }
      } else {
        Serial.println("Failed to connect to MQTT");
      }
    }
  }

  if (mqttClient.connected()){
    mqttClient.poll();
  }

  if (!isMoving && !ledEnabled){
    idleBreathe();
  }
}


// Motor functions_______________________________________________________________
void homePosition(){
  Serial.println("Homing...");
  isHoming = true;
  digitalWrite(DIR_PIN, LOW);
  digitalWrite(ENABLE_PIN, LOW);

  neop.setBrightness(255);
  neop.setPixelColor(0, neop.Color(255, 255, 255)); 
  neop.show();

  while (digitalRead(hallSensor) == HIGH) {
    digitalWrite(STEP_PIN, HIGH);
    delayMicroseconds(1);
    digitalWrite(STEP_PIN, LOW);
    delayMicroseconds(55);
  }
  
  delay(50);
  
  int consecutiveReadings = 0;
  while (consecutiveReadings < 5) {  
    if (digitalRead(hallSensor) == HIGH) {
      digitalWrite(STEP_PIN, HIGH);
      delayMicroseconds(2);
      digitalWrite(STEP_PIN, LOW);
      delayMicroseconds(55);
      consecutiveReadings = 0;
    } else {
      consecutiveReadings++;
    }
  }

  Serial.println("Homing complete");
  currentPosition = 0;
  isHoming = false;
  turnPixOff();
}

void singleStep(){
  digitalWrite(STEP_PIN, HIGH);
  delayMicroseconds(2); 
  digitalWrite(STEP_PIN, LOW);
  delayMicroseconds(55);
}

void moveToScore(float score) {
  score = 1.0 - score;

  if (isMoving) {
      queuedScore = score;
      Serial.println("Moving! Queuing score: " + String(score));
      return;
  }

  isMoving = true;
  
  ledEnabled = true;
  ledState = false;
  blinkStartTime = millis();
  lastBlinkTime = blinkStartTime;
  neop.setBrightness(255);
  updateBlink();
  
  long targetPosition = (long)(score * TOTAL_STEPS);
  long stepsToMove = targetPosition - currentPosition;
  
  Serial.print("steps to move: ");
  Serial.println(abs(stepsToMove));

    bool direction = (stepsToMove > 0);
    
    // First move
    long overshoot = 30000;  // ~5.3mm
    Serial.print("Moving to target plus overshoot: ");
    Serial.println(abs(stepsToMove) + overshoot);
    moveWithRamp(abs(stepsToMove) + overshoot, direction);
    delay(100);
    
    // Second move
    Serial.print("Backtracking to target: ");
    Serial.println(overshoot);
    moveWithRamp(overshoot, !direction);
    
    currentPosition = targetPosition;
    isMoving = false;

    if (queuedScore >= 0) {
        float nextScore = queuedScore;
        queuedScore = -1;
        moveToScore(nextScore);
    }
}

void moveWithRamp(long steps, bool direction) {
  digitalWrite(DIR_PIN, direction ? HIGH : LOW);
  delay(2);

  long actualRampSteps = min(RAMP_STEPS, steps / 3); //don't use more than 1/3 of total steps for ramping!

  //accelerate
  for(long i=0; i < actualRampSteps && i < steps; i++) {
    updateBlink();
    int currentDelay = MAX_DELAY - ((MAX_DELAY - MIN_DELAY) * i / actualRampSteps);
    digitalWrite(STEP_PIN, HIGH);
    delayMicroseconds(1);
    digitalWrite(STEP_PIN, LOW);
    delayMicroseconds(currentDelay);
  }

  //full speed
 for(long i = actualRampSteps; i < steps - actualRampSteps; i++) {
    updateBlink();  
    digitalWrite(STEP_PIN, HIGH);
    delayMicroseconds(1);
    digitalWrite(STEP_PIN, LOW);
    delayMicroseconds(MIN_DELAY);
  }
  
  // Decelerate
  for(long i = 0; i < actualRampSteps && (steps - actualRampSteps + i) < steps; i++) {
    updateBlink();  
    int currentDelay = MIN_DELAY + ((MAX_DELAY - MIN_DELAY) * i / actualRampSteps);
    digitalWrite(STEP_PIN, HIGH);
    delayMicroseconds(1);
    digitalWrite(STEP_PIN, LOW);
    delayMicroseconds(currentDelay);
  }    
  
}

// Network functions_____________________________________________________________
  void onMqttMessage(int messageSize){
  Serial.println("Received a message with topic '");
  Serial.print(mqttClient.messageTopic());
  Serial.print("', length ");
  Serial.print(messageSize);
  Serial.println(" bytes:");

  String message = "";
  while (mqttClient.available()) {
    message += (char)mqttClient.read();
  }
  Serial.print("Raw message: ");
  Serial.println(message);

  int scoreStart = message.indexOf("\"score\":") + 8;
  int scoreEnd = message.indexOf("}", scoreStart);
  
  if (scoreStart > 7 && scoreEnd > scoreStart) {
    String scoreStr = message.substring(scoreStart, scoreEnd);
    float newScore = scoreStr.toFloat();
    
    Serial.print("Parsed score: ");
    Serial.println(newScore, 6);
    
    if (newScore >= 0.0 && newScore <= 1.0) { 
      if (abs(newScore - currentScore) > 0.0001){
        currentScore = newScore;
        targetScore = newScore;
        moveToScore(targetScore);
      } else {
        Serial.println("Score change is too small");
      }
    }
  }
}

bool connectMQTT() {
  int retries = 3;
  while (retries > 0) {
    Serial.print("MQTT connection attempt ");
    Serial.println(4 - retries);
    
    // mqttClient.stop();
    
    String newClientId = "Arduino-" + String(random(0xffff), HEX);
    mqttClient.setId(newClientId.c_str());

    if (mqttClient.connect(broker, port)) {
      Serial.println("Connected to MQTT broker!");
      Serial.print("Using client ID: ");
      Serial.println(newClientId);
      
      mqttClient.onMessage(onMqttMessage);
      
      if (!mqttClient.subscribe(topic)) {
        Serial.println("Failed to subscribe to topic");
        // mqttClient.stop();
        retries--;
        delay(2000);
        continue;
      }
      
      Serial.println("Successfully subscribed to topic");
      return true;
    }
    
    Serial.print("Failed to connect. Error code = ");
    Serial.println(mqttClient.connectError());
    
    retries--;
    delay(2000);
  }
  return false;
}



//Light functions________________________________________________________________
void turnPixOff(){
  neop.setPixelColor(0, neop.Color(0,0,0));
  neop.show();
}

void updateBlink(){
  if (!ledEnabled) return;

  unsigned long currentTime = millis();

  if (!isMoving && (currentTime - blinkStartTime >= BLINK_DURATION)) {
      ledEnabled = false;
      breathBrightness = 0;
      lastBreathTime = currentTime;
      turnPixOff();
      return;
  }

  if (currentTime - lastBlinkTime >= BLINK_INTERVAL) {
    ledState = !ledState;
    neop.setBrightness(255);
    if (ledState) {
      neop.setPixelColor(0, redColor);
    } else {
      neop.setPixelColor(0, neop.Color(0,0,0));
    }
    neop.show();
    lastBlinkTime = currentTime;
  }
}

void idleBreathe(){
  unsigned long currentTime = millis();

  if(currentTime - lastBreathTime >= BREATH_INTERVAL) {
    lastBreathTime = currentTime;

    // breathBrightness = (sin(millis() / 1000.0) + 1) * 127.5;
    breathBrightness = (sin(millis() / 1000.0) + 1) * 80;

    neop.setBrightness(breathBrightness);
    neop.setPixelColor(0, idleColor);
    neop.show();
  }
}
