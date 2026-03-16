# Study Train – Gamified Study Timer with Japanese Train Journeys

Turn your study sessions into virtual train trips across Japan. Choose a line, watch a window‑view video, and watch your progress on an interactive map.

## Features

- **Dashboard** – View your daily study stats, a heatmap calendar, and a timeline of past trips.
- **Interactive Map** – Hover over lines to see details; click on timeline items to recall past journeys.
- **Study Page** – Real‑time map with train marker, station list, video synchronisation, and celebration when you reach a station.
- **CSV Import** – Place your line data in `/lines` (or use the file upload fallback). Each CSV must contain station names, coordinates, timestamps, and a YouTube video URL.

## Getting Started

1. **Clone the repository** and navigate into the folder.
2. **Add your line CSV files** to the `/lines` directory. (See format below.)
3. **Serve the folder** with a local HTTP server (e.g., `python3 -m http.server 8000`).
4. Open `http://localhost:8000` in your browser.

No build tools or API keys required.

## CSV Format

```csv
line_name,station_name,lat,lon,timestamp_seconds,video_url
Yamanote Line,Shinjuku,35.6895,139.7006,0,https://www.youtube.com/watch?v=...
Yamanote Line,Shibuya,35.6586,139.7014,180,https://www.youtube.com/watch?v=...
...