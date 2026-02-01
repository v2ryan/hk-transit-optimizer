# HK Public Transport Optimizer (OTP + TSP)

Goal: Start from **Wong Tai Sin MTR A2** and visit **5 destinations** using **public transport** with minimum total travel time.

This repo implements **Option 2B**:
- OpenTripPlanner (OTP) for public transport journey planning (time + legs)
- A small TSP solver (brute force for 5 stops) to find the optimal visiting order

> Important: OTP needs **OSM + GTFS** data to be accurate. Without GTFS, OTP will fall back to walk-only.

## What you need (data)
1) **OSM extract** covering Hong Kong (PBF)
2) **GTFS zip feed(s)** for HK public transport

Put files here:
- `data/osm/hk.osm.pbf`
- `data/gtfs/*.zip`

## Run
```bash
docker compose up --build
```

Then open:
- http://localhost:3000

OTP API:
- http://localhost:8080

## Notes on GTFS (HK)
Hong Kong GTFS availability varies by operator/licensing. If you don't have an official GTFS, you can:
- Use any legal GTFS feed(s) you have access to.
- Or generate your own GTFS from open route/stop datasets (more work).

If you want, I can add:
- A "GTFS upload" page (so you can upload zip and rebuild graph)
- Better caching + rate limiting
- Export to Google Maps itinerary link
