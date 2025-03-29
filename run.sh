#!/bin/bash

# Variables
SCRAPER_SERVICE_ID="trl-scraper"  # Just the service name, not the full URL
CONFIG_SERVICE_URL="https://updatenewsfetchingconfig-290283837848.us-central1.run.app"  # The actual config service URL
SCHEDULE="*/2 * * * *"            # Every 2 minutes
LOCATION="us-central1"            
PROJECT_ID=$(gcloud config get-value project)  # Get project ID from current config
EXPECTED_PROJECT_ID="your-trl-project-id"  # Define the expected project ID

# At the top of your script, add this check
if [[ "$PROJECT_ID" != "your-trl-project-id" ]]; then
    echo "WARNING: You are not in the TRL project! Current project: $PROJECT_ID"
    read -p "Continue anyway? (yes/no): " confirm
    if [[ "$confirm" != "yes" ]]; then
        echo "Exiting. Run 'gcloud config set project your-trl-project-id' first."
        exit 1
    fi
fi

# Add function to check for firebase functions
check_firebase_functions() {
    echo "Checking for Firebase Functions..."
    # Check if firebase CLI is installed
    if ! command -v firebase &> /dev/null; then
        echo "Firebase CLI not found. Install it to manage Firebase Functions."
        echo "Run: npm install -g firebase-tools"
        return 1
    fi
    
    # Try to list firebase functions
    echo "Listing Firebase Functions (you may need to log in first):"
    firebase functions:list --project="$PROJECT_ID" 2>/dev/null || echo "Could not list Firebase functions. Try 'firebase login' first."
}

# Function to stop firebase functions
stop_firebase_functions() {
    echo "Attempting to stop Firebase Functions..."
    
    # Check if firebase CLI is installed
    if ! command -v firebase &> /dev/null; then
        echo "Firebase CLI not found. Install it to manage Firebase Functions."
        echo "Run: npm install -g firebase-tools"
        return 1
    fi

    # Try to list and delete firebase functions
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

# Add function to delete scheduler job
delete_scheduler_job() {
    JOB_NAME=$1
    LOCATION=$2
    
    echo "Deleting scheduler job: $JOB_NAME in $LOCATION"
    gcloud scheduler jobs delete $JOB_NAME --location="$LOCATION" --quiet
}

# Start both functions
start() {
    echo "Starting scraper and Cloud Function..."

    # Create/update the scraper scheduler job (Cloud Run)
    gcloud scheduler jobs create http trl-scraper-job \
        --schedule="$SCHEDULE" \
        --uri="https://$SCRAPER_SERVICE_ID-290283837848.us-central1.run.app/" \
        --http-method=GET \
        --location="$LOCATION"

    # Enable the news fetching configuration (Cloud Function)
    curl -X POST "$CONFIG_SERVICE_URL" \
        -H "Content-Type: application/json" \
        -d '{"enabled":true,"intervalMinutes":2}'

    echo "Scraper and Cloud Function started with schedule: $SCHEDULE"
}

# Stop functions
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

    # Disable the news fetching configuration (Cloud Function)
    echo "Disabling news fetching configuration..."
    curl -X POST "$CONFIG_SERVICE_URL" \
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
    
    # Delete cloud functions (if user confirms)
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
    
    # Add Firebase Functions handling
    echo -e "\nChecking for Firebase Functions..."
    stop_firebase_functions
    
    echo "All services have been stopped or minimized."
    echo "To verify no functions are running, use: $0 status"
}

# Stop a specific service by name
stop_service() {
    SERVICE_NAME=$1
    
    if [ -z "$SERVICE_NAME" ]; then
        echo "Error: No service name provided"
        echo "Usage: $0 stop-service SERVICE_NAME"
        exit 1
    fi
    
    echo "Stopping service: $SERVICE_NAME"
    
    # Check if service exists
    if gcloud run services describe $SERVICE_NAME --region="$LOCATION" &>/dev/null; then
        # Set minimum instances to 0
        echo "Setting $SERVICE_NAME to 0 instances..."
        gcloud run services update $SERVICE_NAME \
            --min-instances=0 \
            --region="$LOCATION" \
            --project="$PROJECT_ID"
        
        # Remove traffic
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

# Update the schedule
update() {
    echo "Updating schedule to: $SCHEDULE"

    # Update the scraper scheduler job (Cloud Run)
    gcloud scheduler jobs update http trl-scraper-job \
        --schedule="$SCHEDULE" \
        --location="$LOCATION"

    # Update the news fetching configuration (Cloud Function)
    curl -X POST "$CONFIG_SERVICE_URL" \
        -H "Content-Type: application/json" \
        -d "{\"intervalMinutes\":${SCHEDULE#*/}}"

    echo "Schedule updated to: $SCHEDULE"
}

# Function to check status of services
status() {
    echo "Checking status of Cloud services..."
    
    # Check scheduler jobs (in all locations)
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

# Function to list all resources
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

# Function to check and delete a specific Firebase function
check_schedulednewsfetch() {
    echo "Checking for scheduledNewsFetch Firebase Function..."
    
    # Check if the project has the function
    if firebase functions:list | grep -q "scheduledNewsFetch"; then
        echo "Found scheduledNewsFetch function"
        read -p "Do you want to DELETE the scheduledNewsFetch function? (yes/no): " confirm
        if [[ "$confirm" == "yes" ]]; then
            echo "Deleting scheduledNewsFetch function..."
            firebase functions:delete scheduledNewsFetch --force
        else
            echo "Function was not deleted. It will continue to run every 2 minutes."
            echo "The config has been set to disabled, but the function still exists."
        fi
    else
        echo "scheduledNewsFetch function not found in this project."
    fi
}

# Function to verify project context
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
        echo "✅ Project verification successful!"
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
    *)
        echo "Usage: $0 {start|stop|stop-service SERVICE_NAME|update|status|list|verify}"
        exit 1
        ;;
esac
