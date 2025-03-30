#!/bin/bash

get_json_value() {
  local file=$1
  local key=$2
  python -c "import json; print(json.load(open('$file'))$key)"
}

# Variables
SCRAPER_SERVICE_ID="trl-scraper" 
CONFIG_SERVICE_URL="https://updatenewsfetchingconfig-inuqrflg3a-uc.a.run.app" 
SCHEDULE="*/$INTERVAL_MINUTES * * * *"           
LOCATION="us-central1"            
PROJECT_ID="theredline-jn"
EXPECTED_PROJECT_ID="theredline-jn"
DB_COLLECTION=$(get_json_value "config/settings.json" "['database']['collection']")
INTERVAL_MINUTES=$(get_json_value "config/settings.json" "['scheduling']['intervalMinutes']")
GOOGLE_AI_STUDIO_API_KEY=$(get_json_value "config/settings.json" "['gemini']['apiKey']")

GETNEWSFETCHINGCONFIG_URL="https://us-central1-theredline-jn.cloudfunctions.net/getNewsFetchingConfig"
UPDATENEWSFETCHINGCONFIG_URL="https://us-central1-theredline-jn.cloudfunctions.net/updateNewsFetchingConfig"
INITIALIZECONFIG_URL="https://us-central1-theredline-jn.cloudfunctions.net/initializeConfig"
HEALTHCHECK_URL="https://us-central1-theredline-jn.cloudfunctions.net/healthCheck"
TRIGGERNEWSFETCH_URL="https://us-central1-theredline-jn.cloudfunctions.net/triggerNewsFetch"

if [[ "$(gcloud config get-value project)" != "$PROJECT_ID" ]]; then
    echo "⚠️ WARNING: You are not in the TRL project! Current project: $(gcloud config get-value project)"
    read -p "Switch to $PROJECT_ID project? (yes/no): " confirm
    if [[ "$confirm" == "yes" ]]; then
        gcloud config set project $PROJECT_ID
        echo "Switched to project: $PROJECT_ID"
    else
        echo "Exiting. Run 'gcloud config set project $PROJECT_ID' first."
        exit 1
    fi
fi

check_firebase_functions() {
    echo "Checking for Firebase Functions..."
    if ! command -v firebase &> /dev/null; then
        echo "Firebase CLI not found. Install it to manage Firebase Functions."
        echo "Run: npm install -g firebase-tools"
        return 1
    fi
    
    echo "Listing Firebase Functions (you may need to log in first):"
    firebase functions:list --project="$PROJECT_ID" 2>/dev/null || echo "Could not list Firebase functions. Try 'firebase login' first."
}

stop_firebase_functions() {
    echo "Attempting to stop Firebase Functions..."
    
    if ! command -v firebase &> /dev/null; then
        echo "Firebase CLI not found. Install it to manage Firebase Functions."
        echo "Run: npm install -g firebase-tools"
        return 1
    fi

    echo "Do you want to DELETE all Firebase Functions? This requires Firebase CLI access."
    read -p "Proceed? (yes/no): " confirm
    if [[ "$confirm" == "yes" ]]; then
        echo "To delete Firebase Functions, you'll need to:"
        echo "1. Run 'firebase login' if not already logged in"
        echo "2. Run 'firebase functions:delete schedulednewsfetch' to delete the specific function"
        echo "3. Or edit firebase.json to disable the function without deleting it"
        
        # Offer to run the command for them
        read -p "Should I attempt to run 'firebase functions:delete schedulednewsfetch' now? (yes/no): " run_delete
        if [[ "$run_delete" == "yes" ]]; then
            firebase functions:delete schedulednewsfetch --project="$PROJECT_ID" --force
        fi
    else
        echo "Firebase Functions were not modified."
    fi
}

delete_scheduler_job() {
    JOB_NAME=$1
    LOCATION=$2
    
    echo "Deleting scheduler job: $JOB_NAME in $LOCATION"
    gcloud scheduler jobs delete $JOB_NAME --location="$LOCATION" --quiet
}

start() {
    echo "Starting scraper and Cloud Function..."
    
    SCRAPER_URL=$(gcloud run services describe $SCRAPER_SERVICE_ID --platform managed --region $LOCATION --format="value(status.url)")
    
    # Only run between 9AM and 9PM
    SCHEDULE_FORMAT="*/${INTERVAL_MINUTES} 9-21 * * *"
    
    # Delete existing job if it exists
    gcloud scheduler jobs delete trl-news-fetch --location=$LOCATION --quiet 2>/dev/null || true
    
    # Create a new job with proper URL and schedule
    gcloud scheduler jobs create http trl-news-fetch \
      --schedule="$SCHEDULE_FORMAT" \
      --uri="$SCRAPER_URL" \
      --http-method=GET \
      --location=$LOCATION
      
    # Enable the news fetching configuration
    echo "Enabling news fetching configuration..."
    curl -X POST "$UPDATENEWSFETCHINGCONFIG_URL" \
        -H "Content-Type: application/json" \
        -d "{\"enabled\":true,\"intervalMinutes\":$INTERVAL_MINUTES}"
    
    echo "Scraper and Cloud Function started with schedule: $SCHEDULE_FORMAT"
    echo "Target URL: $SCRAPER_URL"
}

stop() {
    echo "Stopping all services..."

    # Check for scheduler jobs in all locations and delete them
    echo "Finding and deleting scheduler jobs..."
    LOCATIONS="us-central1 us-east1 us-west1 europe-west1 asia-east1"
    for loc in $LOCATIONS; do
        JOBS=$(gcloud scheduler jobs list --location="$loc" --format="value(name)" 2>/dev/null | grep -E "quote|trl|news|fetch|scraper" || echo "")
        for job in $JOBS; do
            echo "Found job: $job in $loc"
            job_name=$(basename $job)
            delete_scheduler_job $job_name $loc
        done
    done

    # Disable the news fetching configuration
    echo "Disabling news fetching configuration..."
    curl -X POST "$UPDATENEWSFETCHINGCONFIG_URL" \
        -H "Content-Type: application/json" \
        -d '{"enabled":false}'
    
    # Stop all Cloud Run services
    echo "Finding and stopping all Cloud Run services..."
    AVAILABLE_SERVICES=$(gcloud run services list --platform managed --format="value(metadata.name)")
    
    if [ -z "$AVAILABLE_SERVICES" ]; then
        echo "No Cloud Run services found."
    else
        echo "Found the following services: $AVAILABLE_SERVICES"
        for service in $AVAILABLE_SERVICES; do
            echo "Stopping service: $service"
            
            # Set minimum instances to 0
            echo "Setting $service to 0 instances..."
            gcloud run services update $service \
                --min-instances=0 \
                --region="$LOCATION" \
                --project="$PROJECT_ID"
            
            # Remove traffic - this needs to be done carefully
            echo "Removing traffic from $service..."
            # First create a new revision with no traffic
            gcloud run services update $service \
                --no-traffic \
                --region="$LOCATION" \
                --project="$PROJECT_ID"
                
            # Then ensure service is really stopped by checking
            echo "Verifying service is stopped..."
            gcloud run services describe $service \
                --region="$LOCATION" \
                --format="value(status.traffic)" | grep "percent: 0" || echo "Warning: Service may still have traffic!"
        done
    fi
    
    echo "Finding Cloud Functions..."
    FUNCTIONS=$(gcloud functions list --format="value(name)")
    
    if [ -z "$FUNCTIONS" ]; then
        echo "No Cloud Functions found."
    else
        echo "Found the following functions: $FUNCTIONS"
        read -p "Do you want to DELETE all these Cloud Functions? (yes/no): " confirm
        if [[ "$confirm" == "yes" ]]; then
            for func in $FUNCTIONS; do
                echo "Deleting function: $func"
                gcloud functions delete $func --quiet
            done
        else
            echo "Cloud Functions were not deleted. These may still be running."
        fi
    fi
    
    echo -e "\nChecking for Firebase Functions..."
    stop_firebase_functions
    
    echo "All services have been stopped or minimized."
    echo "To verify no functions are running, use: $0 status"
}

stop_service() {
    SERVICE_NAME=$1
    
    if [ -z "$SERVICE_NAME" ]; then
        echo "Error: No service name provided"
        echo "Usage: $0 stop-service SERVICE_NAME"
        exit 1
    fi
    
    echo "Stopping service: $SERVICE_NAME"
    
    if gcloud run services describe $SERVICE_NAME --region="$LOCATION" &>/dev/null; then
        echo "Setting $SERVICE_NAME to 0 instances..."
        gcloud run services update $SERVICE_NAME \
            --min-instances=0 \
            --region="$LOCATION" \
            --project="$PROJECT_ID"
        
        echo "Removing traffic from $SERVICE_NAME..."
        gcloud run services update $SERVICE_NAME \
            --no-traffic \
            --region="$LOCATION" \
            --project="$PROJECT_ID"
            
        echo "Service $SERVICE_NAME stopped."
    else
        echo "Service $SERVICE_NAME not found."
    fi
}

update() {
    echo "Updating schedule to: $SCHEDULE"

    gcloud scheduler jobs update http trl-scraper-job \
        --schedule="$SCHEDULE" \
        --location="$LOCATION"

    curl -X POST "$CONFIG_SERVICE_URL" \
        -H "Content-Type: application/json" \
        -d "{\"intervalMinutes\":${SCHEDULE#*/}}"

    echo "Schedule updated to: $SCHEDULE"
}

status() {
    echo "Checking status of Cloud services..."
    
    echo "Cloud Scheduler Jobs:"
    LOCATIONS="us-central1 us-east1 us-west1 europe-west1 asia-east1"
    for loc in $LOCATIONS; do
        echo "Location: $loc"
        gcloud scheduler jobs list --location="$loc" 2>/dev/null || echo "  No access to scheduler in $loc"
    done
    
    # List all Cloud Run services
    echo -e "\nAll Cloud Run Services:"
    gcloud run services list --platform managed --format="table(metadata.name,status.url,status.conditions.status,status.conditions.type,status.traffic)" || echo "Unable to list Cloud Run services"
    
    # Check Cloud Functions 
    echo -e "\nAll Cloud Functions:"
    gcloud functions list --format="table(name,status,entryPoint,trigger)" || echo "No Cloud Functions found"
    
    # Add Firebase Functions check
    echo -e "\nFirebase Functions (if any):"
    check_firebase_functions
    
    # Check current config status by getting the configuration
    echo -e "\nConfig Service Status:"
    curl -X GET "$CONFIG_SERVICE_URL" 2>/dev/null || echo "Cannot reach config service"
}

list_all() {
    echo "Listing all cloud resources:"
    
    echo -e "\n=== Cloud Run Services ==="
    gcloud run services list --platform managed --format="table(metadata.name,status.url,region)" || echo "No Cloud Run services found"
    
    echo -e "\n=== Cloud Scheduler Jobs ==="
    LOCATIONS="us-central1 us-east1 us-west1 europe-west1 asia-east1"
    for loc in $LOCATIONS; do
        echo "Location: $loc"
        gcloud scheduler jobs list --location="$loc" --format="table(name,schedule,state)" 2>/dev/null || echo "  No access to scheduler in $loc"
    done
    
    echo -e "\n=== Cloud Functions ==="
    gcloud functions list --format="table(name,status,entryPoint,trigger.eventType)" || echo "No Cloud Functions found"
}


verify_project() {
    echo "Checking TRL project configuration..."
    CURRENT_PROJECT=$(gcloud config get-value project)
    echo "Current project: $CURRENT_PROJECT"
    
    if [[ "$CURRENT_PROJECT" != "$EXPECTED_PROJECT_ID" ]]; then
        echo "⚠️ WARNING: You are NOT in the expected TRL project!"
        echo "Expected: $EXPECTED_PROJECT_ID"
        echo "Current: $CURRENT_PROJECT"
        echo "This may cause deployment issues between projects."
    else
        echo "✅ Project verification successful :-)"
    fi
    
    # List resources specific to this project
    echo -e "\nCloud Run Services:"
    gcloud run services list --platform managed --format="table(metadata.name,status.url)"
    
    echo -e "\nCloud Functions:"
    gcloud functions list --format="table(name,status)"
    
    echo -e "\nFirebase Configuration:"
    firebase use 2>/dev/null || echo "Firebase not configured. Run 'firebase login' and 'firebase use'"
    
    echo -e "\nIf these resources don't look right, switch projects with:"
    echo "gcloud config set project YOUR-TRL-PROJECT-ID"
}

deploy() {
    echo "Deploying TRL services with complete project isolation..."
    
    # Ensure we're in the right configuration
    gcloud config configurations activate trl 2>/dev/null || gcloud config configurations create trl
    gcloud config set project $PROJECT_ID
    gcloud config set compute/region $LOCATION
    
    # Update Application Default Credentials
    gcloud auth application-default set-quota-project $PROJECT_ID
    
    # Build and push Docker image with project-specific tags
    echo "Building Docker image..."
    docker build -t gcr.io/$PROJECT_ID/$SCRAPER_SERVICE_ID:latest .
    
    echo "Pushing to Container Registry..."
    docker push gcr.io/$PROJECT_ID/$SCRAPER_SERVICE_ID:latest
    
    echo "Deploying to Cloud Run with isolated configuration..."
    gcloud run deploy $SCRAPER_SERVICE_ID \
      --image gcr.io/$PROJECT_ID/$SCRAPER_SERVICE_ID:latest \
      --platform managed \
      --region $LOCATION \
      --project $PROJECT_ID \
      --set-env-vars="GOOGLE_CLOUD_PROJECT=$PROJECT_ID,PROJECT_ID=$PROJECT_ID" \
      --tag trl
      
    echo "Deploying Firebase Functions..."
    cd functions
    firebase use $PROJECT_ID
    firebase deploy --only functions --project $PROJECT_ID \
      --set-env-vars="DB_COLLECTION=$DB_COLLECTION,INTERVAL_MINUTES=$INTERVAL_MINUTES,GOOGLE_AI_STUDIO_API_KEY=$GOOGLE_AI_STUDIO_API_KEY"
    cd ..
    
    echo "Starting scheduler..."
    start
    
    echo "Deployment complete. Verify with: $0 status"
}

deploy_only() {
    echo "Deploying TRL services without starting them..."
    
    # Ensure we're in the right configuration
    gcloud config configurations activate trl 2>/dev/null || gcloud config configurations create trl
    gcloud config set project $PROJECT_ID
    gcloud config set compute/region $LOCATION
    
    # Update Application Default Credentials
    gcloud auth application-default set-quota-project $PROJECT_ID
    
    # Check for Firebase credentials
    if [ ! -f "scraping/firebase-credentials.json" ]; then
        echo "⚠️ WARNING: Firebase credentials file not found!"
        echo "Please download a service account key from Firebase console and save it as scraping/firebase-credentials.json"
        read -p "Continue anyway? (yes/no): " continue_without_creds
        if [[ "$continue_without_creds" != "yes" ]]; then
            echo "Exiting. Please add the credentials file and try again."
            exit 1
        fi
    fi
    
    # Build and push Docker image with project-specific tags
    echo "Building Docker image with project-specific tags..."
    docker build --platform linux/amd64 \
                 -t gcr.io/$PROJECT_ID/$SCRAPER_SERVICE_ID:latest \
                 -t gcr.io/$PROJECT_ID/$SCRAPER_SERVICE_ID:v1 \
                 --build-arg PROJECT_ID=$PROJECT_ID \
                 .
    
    echo "Pushing to Container Registry..."
    docker push gcr.io/$PROJECT_ID/$SCRAPER_SERVICE_ID:latest
    docker push gcr.io/$PROJECT_ID/$SCRAPER_SERVICE_ID:v1
    
    echo "Setting Firebase Functions config..."
    firebase functions:config:set \
      db.collection="$DB_COLLECTION" \
      interval.minutes="$INTERVAL_MINUTES" \
      gemini.api_key="$GOOGLE_AI_STUDIO_API_KEY" \
      --project $PROJECT_ID
    
    echo "Deploying Firebase Functions..."
    cd functions
    firebase use $PROJECT_ID
    firebase deploy --only functions --project $PROJECT_ID
    cd ..
    
    echo "Deploying to Cloud Run with isolated configuration..."
    gcloud run deploy $SCRAPER_SERVICE_ID \
      --image gcr.io/$PROJECT_ID/$SCRAPER_SERVICE_ID:latest \
      --platform managed \
      --region $LOCATION \
      --project $PROJECT_ID \
      --set-env-vars="GOOGLE_CLOUD_PROJECT=$PROJECT_ID,PROJECT_ID=$PROJECT_ID,DB_COLLECTION=$DB_COLLECTION,INTERVAL_MINUTES=$INTERVAL_MINUTES,GOOGLE_AI_STUDIO_API_KEY=$GOOGLE_AI_STUDIO_API_KEY" \
      --tag trl
    
    echo "Deployment complete but NOT started. To start services, run: $0 start"
}

# Main script logic
case "$1" in
    start)
        start
        ;;
    stop)
        stop
        ;;
    stop-service)
        stop_service "$2"
        ;;
    update)
        update
        ;;
    status)
        status
        ;;
    list)
        list_all
        ;;
    verify)
        verify_project
        ;;
    deploy)
        deploy
        ;;
    deploy_only)
        deploy_only
        ;;
    *)
        echo "Usage: $0 {start|stop|stop-service SERVICE_NAME|update|status|list|verify|deploy|deploy_only}"
        exit 1
        ;;
esac
