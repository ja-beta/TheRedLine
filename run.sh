#!/bin/bash

# Variables
SCRAPER_SERVICE_ID="trl-scraper"  # Just the service name, not the full URL
CONFIG_SERVICE_URL="https://updatenewsfetchingconfig-290283837848.us-central1.run.app"  # The actual config service URL
SCHEDULE="*/2 * * * *"            # Every 2 minutes
LOCATION="us-central1"            

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

# Stop both functions
stop() {
    echo "Stopping scraper and Cloud Function..."

    # Delete the scraper scheduler job (Cloud Run)
    gcloud scheduler jobs delete trl-scraper-job --quiet --location="$LOCATION"

    # Disable the news fetching configuration (Cloud Function)
    curl -X POST "$CONFIG_SERVICE_URL" \
        -H "Content-Type: application/json" \
        -d '{"enabled":false}'

    echo "Scraper and Cloud Function stopped."
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

# Main script logic
case "$1" in
    start)
        start
        ;;
    stop)
        stop
        ;;
    update)
        update
        ;;
    *)
        echo "Usage: $0 {start|stop|update}"
        exit 1
        ;;
esac
