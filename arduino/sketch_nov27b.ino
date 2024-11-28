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

const long TOTAL_STEPS = 476667;  // for 30 cm(?) - need to change to 34!
long currentPosition = 0;
float targetScore = 0.0;
float currentScore = 0.0;

bool isHoming = false;
bool ledEnabled = false;
bool ledState = false;
unsigned long lastBlinkTime = 0;
const unsigned long BLINK_INTERVAL = 1000;
unsigned long blinkStartTime = 0;
const unsigned long BLINK_DURATION = 20000;

void setup() {
  Serial.begin(9600);
  randomSeed(analogRead(0));


  while (!Serial) {
    delay(10);
  }
  Serial.println("starting...");

  // LED setup
  neop.begin();

  // Hall sensor setup
  pinMode(hallSensor, INPUT_PULLUP);

  // Motor setup
  pinMode(STEP_PIN, OUTPUT);
  pinMode(DIR_PIN, OUTPUT);
  pinMode(ENABLE_PIN, OUTPUT);

  digitalWrite(ENABLE_PIN, LOW);

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
  //mqttClient.setKeepAliveInterval(15 * 1000); // 15 seconds
  //mqttClient.setConnectionTimeout(10 * 1000); // 10 seconds
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
  mqttClient.poll();

  unsigned long currentMillis = millis();

  if (currentMillis - lastConnectionCheck >= CONNECTION_CHECK_INTERVAL){
    lastConnectionCheck = currentMillis;

    if(!mqttClient.connected()){
      Serial.println("MQTT connection lost, reconnecting...");
      connectMQTT();
    }
  }
}

// Motor functions_______________________________________________________________
void homePosition(){
  Serial.println("Homing...");
  isHoming = true;
  digitalWrite(DIR_PIN, LOW);

  neop.setBrightness(100);
  neop.setPixelColor(0, neop.Color(255, 255, 255)); 
  neop.show();

  while (digitalRead(hallSensor) == HIGH){
    singleStep();
    delay(1);
  }

  Serial.println("Homing complete");
  currentPosition = 0;
  isHoming = false;
  turnPixOff();
}

void singleStep(){
  digitalWrite(STEP_PIN, HIGH);
  delayMicroseconds(70); //higher number = slower speed
  digitalWrite(STEP_PIN, LOW);
  delayMicroseconds(70);
}

void moveToScore(float score) {
  ledEnabled = true;
  ledState = false;
  blinkStartTime = millis();
  lastBlinkTime = blinkStartTime;
  updateBlink();
  
  long targetPosition = (long)(score * TOTAL_STEPS);
  long stepsToMove = targetPosition - currentPosition;

  Serial.print("Target steps: ");
  Serial.println(stepsToMove);

  long overshootSteps = stepsToMove + (stepsToMove / 10);  // 10% overshoot
  long backtrackSteps = (overshootSteps - stepsToMove) + (stepsToMove / 20);  // Extra 5% back
  long finalSteps = backtrackSteps - (stepsToMove / 20);  // Forward 5% to target

  // First move
  digitalWrite(DIR_PIN, stepsToMove > 0 ? HIGH : LOW);
  delay(5);
  for (long i = 0; i < abs(overshootSteps); i++) {
    updateBlink();
    digitalWrite(STEP_PIN, HIGH);
    delayMicroseconds(300);
    digitalWrite(STEP_PIN, LOW);
    delayMicroseconds(300);
  }

  delay(50);

  // Second move
  digitalWrite(DIR_PIN, stepsToMove > 0 ? LOW : HIGH);
  delay(5);
  for (long i = 0; i < abs(backtrackSteps); i++) {
    updateBlink();
    digitalWrite(STEP_PIN, HIGH);
    delayMicroseconds(400);
    digitalWrite(STEP_PIN, LOW);
    delayMicroseconds(400);
  }

  delay(50); 

  // Third move
  digitalWrite(DIR_PIN, stepsToMove > 0 ? HIGH : LOW);
  delay(5);
  for (long i = 0; i < abs(finalSteps); i++) {
    updateBlink();
    digitalWrite(STEP_PIN, HIGH);
    delayMicroseconds(500);  
    digitalWrite(STEP_PIN, LOW);
    delayMicroseconds(500);
  }

  currentPosition = targetPosition;
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
      if (abs(newScore - currentScore) > 0.0001) {
        currentScore = newScore;
        targetScore = newScore;
        moveToScore(targetScore);
      }
    }
  }
}

bool connectMQTT() {
  int retries = 3;
  while (retries > 0) {
    Serial.print("MQTT connection attempt ");
    Serial.println(4 - retries);
    
    mqttClient.setId(clientId.c_str());

    if (mqttClient.connect(broker, port)) {
      Serial.println("Connected to MQTT broker!");
      Serial.print("Using client ID: ");
      Serial.println(clientId);
      
      if (!mqttClient.subscribe(topic)) {
        Serial.println("Failed to subscribe to topic");
        return false;
      }
      Serial.println("Subscribed to topic");
      
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

  if (currentTime - blinkStartTime >= BLINK_DURATION) {
    ledEnabled = false;
    turnPixOff();
    return;
  }

  if (currentTime - lastBlinkTime >= BLINK_INTERVAL) {
    ledState = !ledState;
    neop.setBrightness(255);
    if (ledState) {
      neop.setPixelColor(0, neop.Color(255, 0, 0));
    } else {
      neop.setPixelColor(0, neop.Color(0, 0, 0));
    }
    neop.show();
    lastBlinkTime = currentTime;
  }
}






















