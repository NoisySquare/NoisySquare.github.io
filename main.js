// ==================== LEAFLET READY PROMISE (with fallback) ====================
const leafletReady = new Promise((resolve) => {
    // If already loaded, resolve immediately
    if (window.L) {
        resolve();
        return;
    }

    // Try to attach to the existing script tag
    const leafletScript = document.querySelector('script[src*="leaflet.js"]');
    let fallbackAttempted = false;

    function onLoad() {
        if (window.L) {
            clearInterval(checkInterval);
            resolve();
        }
    }

    function onError() {
        if (!fallbackAttempted) {
            fallbackAttempted = true;
            console.warn('Leaflet CDN failed, trying fallback...');
            const fallback = document.createElement('script');
            fallback.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js';
            fallback.onload = onLoad;
            fallback.onerror = () => {
                console.error('Fallback also failed. Map will not work.');
                // Still resolve to avoid hanging the app
                clearInterval(checkInterval);
                resolve();
            };
            document.head.appendChild(fallback);
        }
    }

    if (leafletScript) {
        leafletScript.addEventListener('load', onLoad);
        leafletScript.addEventListener('error', onError);
    } else {
        // No script tag found – create one dynamically
        const newScript = document.createElement('script');
        newScript.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
        newScript.onload = onLoad;
        newScript.onerror = onError;
        document.head.appendChild(newScript);
    }

    // Polling fallback in case events fire too early or miss
    const checkInterval = setInterval(() => {
        if (window.L) {
            clearInterval(checkInterval);
            resolve();
        }
    }, 50);

    // Safety timeout after 10 seconds
    setTimeout(() => {
        clearInterval(checkInterval);
        console.warn('Leaflet loading timed out');
        resolve(); // Resolve anyway so the app doesn't freeze
    }, 10000);
});

// ==================== STATE ====================
let lines = [];                     // array of line objects
let userData = {
    sessions: []                     // array of { date, lineId, duration, distance, startStation, endStation }
};
let currentView = 'dashboard';       // 'dashboard' or 'study'
let currentLine = null;              // line object for study session
let timerInterval = null;
let syncInterval = null;
let timerSeconds = 0;
let timerRunning = false;
let videoPlayer = null;
let youtubeReady = false;
let dashboardMap = null;
let studyMap = null;
let trainMarker = null;
let travelledPolyline = null;
let stationMarkers = [];
let selectedLineIdForTravel = null;
let globalStats = { totalMinutes: 0, totalKm: 0, streak: 0 };
let currentSelectedDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
let currentTripDistance = 0;          // distance covered in current session (km)
let currentActivityLog = [];   // for the ongoing study session
let todoList = [];


// DOM elements
const appEl = document.getElementById('app');

// Templates
const dashboardTemplate = document.getElementById('dashboard-template').innerHTML;
const travelModalTemplate = document.getElementById('travel-modal-template').innerHTML;
const studyTemplate = document.getElementById('study-template').innerHTML;

// ==================== INIT ====================
document.addEventListener('DOMContentLoaded', async () => {
    await loadUserDataFromDB();   // now awaits properly
    await loadLinesFromManifest();
    renderDashboard();
});

// ==================== INDEXEDDB SETUP (with localStorage fallback) ====================
const DB_NAME = 'StudyTrainDB';
const DB_VERSION = 1;
const STORE_NAME = 'userData';

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => {
            console.error('IndexedDB open error:', request.error);
            reject(request.error);
        };
        request.onsuccess = () => {
            console.log('IndexedDB opened successfully');
            resolve(request.result);
        };
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                console.log('Object store created');
            }
        };
    });
}

async function loadUserDataFromDB() {
    try {
        const db = await openDB();
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const request = store.get('userData');
            
            request.onsuccess = () => {
                if (request.result) {
                    userData = request.result.data;
                    console.log('Loaded from IndexedDB:', userData);
                } else {
                    console.log('No data in IndexedDB, starting fresh');
                    userData = { sessions: [] };
                }
                
                // Set currentSelectedDate to the most recent session date, or today if none
                if (userData.sessions.length > 0) {
                    const sorted = [...userData.sessions].sort((a, b) => b.date.localeCompare(a.date));
                    currentSelectedDate = sorted[0].date;
                } else {
                    currentSelectedDate = new Date().toISOString().split('T')[0];
                }
                
                computeGlobalStats();
                resolve();
            };
            
            request.onerror = () => {
                console.error('Error reading from IndexedDB, using empty data');
                userData = { sessions: [] };
                currentSelectedDate = new Date().toISOString().split('T')[0];
                computeGlobalStats();
                resolve();
            };
        });
    } catch (e) {
        console.error('Failed to load from IndexedDB, using empty data', e);
        userData = { sessions: [] };
        currentSelectedDate = new Date().toISOString().split('T')[0];
        computeGlobalStats();
    }
}

async function saveUserDataToDB() {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put({ id: 'userData', data: userData });
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => {
                console.log('Saved to IndexedDB:', userData);
                resolve();
            };
            tx.onerror = () => {
                console.error('IndexedDB save error:', tx.error);
                reject(tx.error);
            };
        });
    } catch (e) {
        console.error('IndexedDB save failed, using localStorage fallback', e);
        // Fallback to localStorage
        localStorage.setItem('studyTrain_userData', JSON.stringify(userData));
        console.log('Saved to localStorage fallback');
    }
}


// ==================== DATA LOADING ====================
function loadUserData() {
    loadUserDataFromDB(); // asynchronous, but we don't need to wait here
}

function saveUserData() {
    saveUserDataToDB().catch(e => {
        console.error('Save failed, but fallback already handled', e);
    }).finally(() => {
        computeGlobalStats();
    });
}

function deleteSession(sessionId) {
    if (!confirm('Delete this session?')) return;
    userData.sessions = userData.sessions.filter(s => s.id !== sessionId);
    saveUserData();
    // Reload the current day log
    loadDailyLog(currentSelectedDate);
    // Also update global stats and heatmap
    updateGlobalStatsUI();
    renderHeatmap();
}

function computeGlobalStats() {
    let totalMinutes = 0, totalKm = 0;
    const sessionsByDate = {};
    userData.sessions.forEach(s => {
        totalMinutes += s.duration;
        totalKm += s.distance;
        const dateStr = s.date;
        sessionsByDate[dateStr] = (sessionsByDate[dateStr] || 0) + s.duration;
    });
    globalStats.totalMinutes = totalMinutes;
    globalStats.totalKm = totalKm;
    // simple streak: count consecutive days from today backwards with any session
    let streak = 0;
    const today = new Date().toISOString().split('T')[0];
    let checkDate = new Date(today);
    while (true) {
        const dateStr = checkDate.toISOString().split('T')[0];
        if (sessionsByDate[dateStr]) {
            streak++;
            checkDate.setDate(checkDate.getDate() - 1);
        } else {
            break;
        }
    }
    globalStats.streak = streak;
}

async function loadLinesFromManifest() {
    try {
        const response = await fetch('lines/index.json');
        if (!response.ok) throw new Error('Manifest not found. Please create lines/index.json with an array of CSV filenames.');
        const fileList = await response.json(); // e.g. ["yamanote.csv", "tokkaido.csv"]
        for (const file of fileList) {
            const csvResp = await fetch(`lines/${file}`);
            if (csvResp.ok) {
                const csvText = await csvResp.text();
                parseAndAddLine(csvText);
            } else {
                console.warn(`Could not fetch ${file}`);
            }
        }
    } catch (e) {
        console.error(e.message);
        // Show a message in the dashboard if it's already rendered
        if (currentView === 'dashboard') {
            showNoLinesMessage();
        }
    }
}

function showNoLinesMessage() {
    const container = document.querySelector('.dashboard .greeting');
    if (container) {
        const msg = document.createElement('div');
        msg.className = 'warning-message';
        msg.innerHTML = '<i class="fas fa-exclamation-triangle"></i> No lines loaded. Please create <code>lines/index.json</code> and place CSV files in the <code>/lines</code> folder.';
        container.appendChild(msg);
    }
}

function parseAndAddLine(csvText) {
    Papa.parse(csvText, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
            processCSVData(results.data);
        }
    });
}

function processCSVData(rows) {
    const linesMap = new Map();
    rows.forEach(row => {
        const lineName = row.line_name?.trim();
        if (!lineName) return;
        if (!linesMap.has(lineName)) {
            linesMap.set(lineName, {
                name: lineName,
                videoUrl: row.video_url?.trim(),
                stations: []
            });
        }
        const station = {
            name: row.station_name?.trim(),
            lat: parseFloat(row.lat),
            lon: parseFloat(row.lon),
            timestamp: parseInt(row.timestamp_seconds, 10) || 0
        };
        if (!isNaN(station.lat) && !isNaN(station.lon)) {
            linesMap.get(lineName).stations.push(station);
        }
    });

    linesMap.forEach((line, name) => {
        if (line.stations.length < 2) return;
        line.stations.sort((a,b) => a.timestamp - b.timestamp);
        // compute cumulative distances
        let cumDists = [0];
        for (let i = 1; i < line.stations.length; i++) {
            const d = haversineDistance(line.stations[i-1], line.stations[i]);
            cumDists.push(cumDists[i-1] + d);
        }
        line.cumulativeDists = cumDists;
        line.totalLength = cumDists[cumDists.length - 1];
        line.id = `line-${name.replace(/[^a-zA-Z0-9]/g, '_')}`; // stable ID
        lines.push(line);
    });

    // Re-render dashboard if it's the current view
    if (currentView === 'dashboard') renderDashboard();
}

function haversineDistance(p1, p2) {
    const R = 6371;
    const dLat = (p2.lat - p1.lat) * Math.PI / 180;
    const dLon = (p2.lon - p1.lon) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(p1.lat * Math.PI/180) * Math.cos(p2.lat * Math.PI/180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

// ==================== RENDERING ====================
function renderDashboard() {
    document.body.classList.remove('study-mode');
    currentView = 'dashboard';
    appEl.innerHTML = dashboardTemplate;

    const hour = new Date().getHours();
    let greeting = 'Morning';
    if (hour >= 12 && hour < 17) greeting = 'Afternoon';
    else if (hour >= 17) greeting = 'Evening';
    document.getElementById('greeting-time').innerText = greeting;
    document.getElementById('user-name').innerText = 'Traveller';

    updateGlobalStatsUI();
    initDashboardMap();
    renderHeatmap();
    
    // Update selected date display and load log
    document.getElementById('selected-date-display').innerText = currentSelectedDate;
    loadDailyLog(currentSelectedDate);

    document.getElementById('travel-now').addEventListener('click', openTravelModal);
    document.getElementById('clear-data').addEventListener('click', clearAllData);
}

async function initDashboardMap() {
    await leafletReady;
    if (!window.L) {
        console.error('Leaflet not available even after waiting');
        const mapEl = document.getElementById('daily-map');
        if (mapEl) mapEl.innerHTML = '<div class="error-message">Map library failed to load. Please refresh.</div>';
        return;
    }
    if (dashboardMap) dashboardMap.remove();
    dashboardMap = L.map('daily-map').setView([35.68, 139.76], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap'
    }).addTo(dashboardMap);

    if (lines.length === 0) return;

    lines.forEach(line => {
        const latlngs = line.stations.map(s => [s.lat, s.lon]);
        const polyline = L.polyline(latlngs, { color: '#4aa5ff', weight: 3, opacity: 0.7 }).addTo(dashboardMap);
        polyline.on('mouseover', () => {
            polyline.bindTooltip(`${line.name} – ${line.stations.length} stations, ${line.totalLength.toFixed(1)} km`).openTooltip();
        });
        polyline.on('mouseout', () => {
            polyline.closeTooltip();
        });
    });
}

function renderHeatmap() {
    const heatmapEl = document.getElementById('heatmap');
    if (!heatmapEl) {
        console.warn('Heatmap container missing');
        return;
    }
    heatmapEl.innerHTML = '';
    const today = new Date();
    // Show last 30 days
    for (let i = 29; i >= 0; i--) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];
        const daySessions = userData.sessions.filter(s => s.date === dateStr);
        const totalMins = daySessions.reduce((acc, s) => acc + s.duration, 0);
        // Intensity based on minutes (max 300 min = 5h)
        let intensity = totalMins > 0 ? Math.min(1, totalMins / 300) : 0.1;
        const color = `rgba(45, 127, 193, ${intensity})`;
        const dayDiv = document.createElement('div');
        dayDiv.className = 'heatmap-day';
        dayDiv.style.backgroundColor = color;
        dayDiv.dataset.date = dateStr;
        dayDiv.title = `${dateStr}: ${totalMins} min`;
        dayDiv.addEventListener('click', () => {
            document.getElementById('selected-date-display').innerText = dateStr;
            currentSelectedDate = dateStr;
            loadDailyLog(dateStr);
        });
        heatmapEl.appendChild(dayDiv);
    }
}

function setupDateSelection() {
    const todayStr = new Date().toISOString().split('T')[0];
    document.getElementById('selected-date-display').innerText = todayStr;
}

function updateGlobalStatsUI() {
    const totalTimeEl = document.getElementById('total-time-global');
    const totalDistEl = document.getElementById('total-distance-global');
    const streakEl = document.getElementById('streak');
    if (totalTimeEl) totalTimeEl.innerText = globalStats.totalMinutes + ' min';
    if (totalDistEl) totalDistEl.innerText = globalStats.totalKm.toFixed(1) + ' km';
    if (streakEl) streakEl.innerText = globalStats.streak + ' days';
}

function loadDailyLog(dateStr) {
    const sessions = userData.sessions.filter(s => s.date === dateStr);
    const totalTime = sessions.reduce((acc, s) => acc + s.duration, 0);
    const totalDist = sessions.reduce((acc, s) => acc + s.distance, 0);
    document.getElementById('today-time').innerText = totalTime + ' min';
    document.getElementById('today-distance').innerText = totalDist.toFixed(1) + ' km';

    const timelineEl = document.getElementById('timeline');
    timelineEl.innerHTML = '';
    if (sessions.length === 0) {
        timelineEl.innerHTML = '<p class="empty-message">No sessions on this day</p>';
        return;
    }
    sessions.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
    sessions.forEach(s => {
        const line = lines.find(l => l.id === s.lineId);
        if (!line) return;
        const div = document.createElement('div');
        div.className = 'timeline-item';
        div.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <strong>${line.name}</strong> · ${s.duration} min<br>
                    ${s.startStation || '?'} → ${s.endStation || '?'} · ${s.distance.toFixed(1)} km
                </div>
                <button class="delete-session-btn" data-id="${s.id}" title="Delete session"><i class="fas fa-trash"></i></button>
            </div>
        `;
        const deleteBtn = div.querySelector('.delete-session-btn');
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // prevent triggering the timeline click
            deleteSession(s.id);
        });
        div.addEventListener('click', () => {
            if (dashboardMap && line) {
                const latlngs = line.stations.map(s => [s.lat, s.lon]);
                dashboardMap.fitBounds(latlngs, { padding: [50, 50] });
            }
        });
        timelineEl.appendChild(div);
    });
}

function clearAllData() {
    if (!confirm('Are you sure? This will permanently delete all your study sessions.')) return;
    userData.sessions = [];
    saveUserData();
    // Refresh dashboard
    renderDashboard();
}

// ==================== TRAVEL MODAL ====================
async function openTravelModal() {
    // Wait for Leaflet to be ready (with fallback)
    await leafletReady;

    // Clone template content properly
    const template = document.getElementById('travel-modal-template');
    const modalContent = template.content.cloneNode(true);
    appEl.appendChild(modalContent);

    // Now get elements from the newly added modal
    const modal = document.querySelector('.modal-overlay'); // or use id if set
    const lineListEl = document.getElementById('line-list');
    const previewMapEl = document.getElementById('preview-map');
    const goBtn = document.getElementById('go-button');
    const closeBtn = document.getElementById('close-modal');
    const goalInput = document.getElementById('trip-goal');

    // Safety checks
    if (!lineListEl || !previewMapEl || !goBtn || !closeBtn) {
        console.error('Modal elements missing');
        return;
    }

    lineListEl.innerHTML = '';

    if (lines.length === 0) {
        lineListEl.innerHTML = '<div class="empty-message">No lines available. Please add CSV files to /lines and refresh.</div>';
        goBtn.disabled = true;
    } else {
        lines.forEach(line => {
            const item = document.createElement('div');
            item.className = 'line-item';
            item.dataset.id = line.id;
            item.innerText = `${line.name} (${line.stations.length} stations, ${line.totalLength.toFixed(1)} km)`;
            item.addEventListener('mouseenter', () => {
                drawLineOnPreviewMap(previewMap, line);
            });
            item.addEventListener('click', () => {
                document.querySelectorAll('.line-item').forEach(el => el.classList.remove('selected'));
                item.classList.add('selected');
                selectedLineIdForTravel = line.id;
                goBtn.disabled = false;
            });
            lineListEl.appendChild(item);
        });
    }

    // Static preview map – only if Leaflet is available
    let previewMap = null;
    if (window.L) {
        try {
            previewMap = L.map(previewMapEl, {
                zoomControl: false,
                dragging: false,
                touchZoom: false,
                scrollWheelZoom: false
            }).setView([35.68, 139.76], 5);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(previewMap);
        } catch (e) {
            console.error('Preview map error', e);
            previewMapEl.innerHTML = '<div class="error-message">Map unavailable</div>';
        }
    } else {
        previewMapEl.innerHTML = '<div class="error-message">Map library not loaded</div>';
    }

    function drawLineOnPreviewMap(map, line) {
        if (!map || !window.L) return;
        // Clear previous lines
        map.eachLayer(l => {
            if (l instanceof L.Polyline) map.removeLayer(l);
        });
        const latlngs = line.stations.map(s => [s.lat, s.lon]);
        L.polyline(latlngs, { color: '#ffaa33', weight: 4 }).addTo(map);
        map.fitBounds(latlngs, { padding: [20, 20] });
    }

    closeBtn.addEventListener('click', () => {
        modal.remove(); // Remove the whole modal
    });

    goBtn.addEventListener('click', () => {
        const line = lines.find(l => l.id === selectedLineIdForTravel);
        if (line) {
            const goal = goalInput.value.trim();
            startStudySession(line, goal);
        }
        modal.remove();
    });
}

// ==================== STUDY PAGE ====================
function startStudySession(line, goal) {
    currentLine = line;
    currentView = 'study';
    appEl.innerHTML = studyTemplate;
    document.body.classList.add('study-mode');

    // Store first station timestamp for seeking
    window.firstStationTimestamp = line.stations[0].timestamp;

    // Load video
    loadYouTubeVideo(line.videoUrl);

    // Initialize mini map
    initMiniMap(line);

    // Populate route line
    renderRouteLine(line);

    // Set up timer (count up)
    timerSeconds = 0;
    updateStudyTimerDisplay();
    document.getElementById('trip-dist').innerText = '0.0';

    // To-do list
    todoList = [];
    if (goal && goal.trim() !== '') {
        todoList.push({ text: goal, completed: false });
    }
    renderTodoList();

    // Event listeners
    document.getElementById('back-to-dashboard').addEventListener('click', () => {
        pauseTimer();
        renderDashboard();
    });

    document.getElementById('add-todo').addEventListener('click', () => {
        const input = document.getElementById('new-todo');
        const text = input.value.trim();
        if (text) {
            todoList.push({ text, completed: false });
            renderTodoList();
            input.value = '';
        }
    });

    // New button listeners
    document.getElementById('play-pause-btn').addEventListener('click', togglePlayPause);
    document.getElementById('complete-btn').addEventListener('click', completeSession);
    document.getElementById('study-reset').addEventListener('click', resetTimer);
}

function togglePlayPause() {
    if (timerRunning) {
        pauseTimer();
        document.getElementById('play-pause-btn').innerHTML = '<i class="fas fa-play"></i> <span>Start</span>';
    } else {
        startTimer();
        document.getElementById('play-pause-btn').innerHTML = '<i class="fas fa-pause"></i> <span>Pause</span>';
    }
}


function addActivityLogEntry(text) {
    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0].substring(0,5); // HH:MM
    currentActivityLog.push({ time: timeStr, text: text });
    renderActivityLog();
}

function renderActivityLog() {
    const container = document.getElementById('activity-entries');
    if (!container) return;
    container.innerHTML = '';
    currentActivityLog.forEach(entry => {
        const div = document.createElement('div');
        div.className = 'log-entry';
        div.innerHTML = `<span class="log-time">[${entry.time}]</span> <span class="log-text">${entry.text}</span>`;
        container.appendChild(div);
    });
}

function renderTodoList() {
    const container = document.getElementById('todo-list');
    container.innerHTML = '';
    todoList.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = `todo-item ${item.completed ? 'completed' : ''}`;
        div.innerHTML = `
            <input type="checkbox" ${item.completed ? 'checked' : ''} data-index="${index}">
            <span>${item.text}</span>
            <button class="todo-delete" data-index="${index}"><i class="fas fa-trash"></i></button>
        `;
        const checkbox = div.querySelector('input');
        checkbox.addEventListener('change', (e) => {
            todoList[index].completed = e.target.checked;
            renderTodoList();
        });
        const deleteBtn = div.querySelector('.todo-delete');
        deleteBtn.addEventListener('click', () => {
            todoList.splice(index, 1);
            renderTodoList();
        });
        container.appendChild(div);
    });
}

function initMiniMap(line) {
    leafletReady.then(() => {
        if (!window.L) return;
        if (studyMap) studyMap.remove();
        const mapDiv = document.getElementById('study-map');
        if (!mapDiv) return;

        studyMap = L.map(mapDiv, {
            zoomControl: false,
            dragging: false,
            touchZoom: false,
            scrollWheelZoom: false,
            doubleClickZoom: false,
            boxZoom: false,
            keyboard: false,
            attributionControl: false
        }).setView([35.68, 139.76], 5);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(studyMap);

        // Draw line
        const latlngs = line.stations.map(s => [s.lat, s.lon]);
        L.polyline(latlngs, { color: '#4aa5ff', weight: 3 }).addTo(studyMap);

        // Add station markers with tooltips
        line.stations.forEach((s, idx) => {
            const marker = L.circleMarker([s.lat, s.lon], {
                radius: 4,
                color: '#ffaa33',
                fillColor: '#ffaa33',
                fillOpacity: 1
            }).addTo(studyMap);
            marker.bindTooltip(`${s.name} (S${idx})`, { permanent: false, direction: 'top' });
        });

        // Train marker
        trainMarker = L.marker([line.stations[0].lat, line.stations[0].lon], {
            icon: L.divIcon({ className: 'train-marker', html: '🚊', iconSize: [20,20] })
        }).addTo(studyMap);

        studyMap.setView([line.stations[0].lat, line.stations[0].lon], 12);
    });
}


function initStudyMap(line) {
    if (studyMap) studyMap.remove();
    studyMap = L.map('study-map').setView([line.stations[0].lat, line.stations[0].lon], 10);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(studyMap);

    const latlngs = line.stations.map(s => [s.lat, s.lon]);
    L.polyline(latlngs, { color: '#4aa5ff', weight: 8, opacity: 0.5 }).addTo(studyMap);

    stationMarkers = [];
    line.stations.forEach((s, idx) => {
        const marker = L.circleMarker([s.lat, s.lon], {
            radius: 5,
            color: '#ffaa33',
            fillColor: '#ffaa33',
            fillOpacity: 1
        }).addTo(studyMap);
        marker.bindPopup(s.name);
        stationMarkers.push(marker);
    });

    trainMarker = L.marker([line.stations[0].lat, line.stations[0].lon], {
        icon: L.divIcon({
            className: 'train-marker',
            html: '★ YOU ARE HERE',
            iconSize: [100, 20],
            iconAnchor: [50, 10]
        })
    }).addTo(studyMap);

    travelledPolyline = L.polyline([], { color: '#ffaa33', weight: 8 }).addTo(studyMap);
    studyMap.fitBounds(latlngs, { padding: [30,30] });

    studyMap.dragging.disable();
    studyMap.touchZoom.disable();
    studyMap.scrollWheelZoom.disable();
    studyMap.doubleClickZoom.disable();
    studyMap.boxZoom.disable();
    studyMap.keyboard.disable();
    if (studyMap.tap) studyMap.tap.disable(); // for mobile
}

function renderRouteLine(line) {
    const container = document.getElementById('route-line');
    container.innerHTML = '';
    line.stations.forEach((station, idx) => {
        const div = document.createElement('div');
        div.className = 'route-station';
        div.dataset.index = idx;
        const dotClass = idx === 0 ? 'dot current' : 'dot';
        const timeStr = formatTime(station.timestamp);
        div.innerHTML = `
            <div class="${dotClass}"></div>
            <span class="name">${station.name}</span>
            <span class="time">${timeStr}</span>
        `;
        container.appendChild(div);
    });
}

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2,'0')}`;
}





function populateStationList(line) {
    const listEl = document.getElementById('station-list');
    listEl.innerHTML = '';
    line.stations.forEach((s, idx) => {
        const div = document.createElement('div');
        div.className = 'station-item';
        div.dataset.index = idx;
        const label = `(S${idx})`;
        div.innerHTML = `<span>${label} ${s.name}</span><span>${idx === 0 ? 'Start' : ''}${idx === line.stations.length-1 ? 'Destination' : ''}</span>`;
        listEl.appendChild(div);
    });
}

function pauseTimer() {
    timerRunning = false;
    clearInterval(timerInterval);
    clearInterval(syncInterval);
    if (videoPlayer) videoPlayer.pauseVideo();

    const btn = document.getElementById('play-pause-btn');
    if (btn) btn.innerHTML = '<i class="fas fa-play"></i> <span>Start</span>';
}

function startTimer() {
    if (timerRunning) return;
    if (!videoPlayer || !youtubeReady) {
        alert('Video not ready');
        return;
    }
    timerRunning = true;
    videoPlayer.playVideo();

    // Update button
    const btn = document.getElementById('play-pause-btn');
    if (btn) btn.innerHTML = '<i class="fas fa-pause"></i> <span>Pause</span>';

    // Count up every second
    timerInterval = setInterval(() => {
        timerSeconds++;
        updateStudyTimerDisplay();
    }, 1000);

    syncInterval = setInterval(() => {
        if (videoPlayer && videoPlayer.getCurrentTime) {
            const time = videoPlayer.getCurrentTime();
            if (!isNaN(time)) {
                updateMapAndStationForTime(time);
            }
        }
    }, 500);
}

function resetTimer() {
    pauseTimer();
    timerSeconds = 0;
    updateStudyTimerDisplay();
    if (videoPlayer && videoPlayer.seekTo && window.firstStationTimestamp !== undefined) {
        videoPlayer.seekTo(window.firstStationTimestamp);
        updateMapAndStationForTime(window.firstStationTimestamp);
    }
    document.getElementById('trip-dist').innerText = '0.0';

    // Reset play/pause button
    const btn = document.getElementById('play-pause-btn');
    if (btn) btn.innerHTML = '<i class="fas fa-play"></i> <span>Start</span>';
}

function updateStudyTimerDisplay() {
    const hrs = Math.floor(timerSeconds / 3600);
    const mins = Math.floor((timerSeconds % 3600) / 60);
    const secs = timerSeconds % 60;
    document.getElementById('study-timer').innerText = 
        `${hrs.toString().padStart(2,'0')}:${mins.toString().padStart(2,'0')}:${secs.toString().padStart(2,'0')}`;
}

function updateNextStationTimer(timeSec) {
    if (!currentLine) return;
    const stations = currentLine.stations;
    let nextIdx = stations.findIndex(s => s.timestamp > timeSec);
    if (nextIdx === -1) nextIdx = stations.length - 1;
    const nextTime = stations[nextIdx].timestamp;
    const remain = Math.max(0, nextTime - timeSec);
    const mins = Math.floor(remain / 60);
    const secs = Math.floor(remain % 60);
    // We don't have a dedicated element for this in new UI, but we could add a small label if desired.
    // For now, we skip.
}

function updateMapAndStationForTime(timeSec) {
    if (!currentLine || !trainMarker) return;

    const stations = currentLine.stations;
    const cumDists = currentLine.cumulativeDists;
    const totalTime = stations[stations.length-1].timestamp;

    if (timeSec < 0) timeSec = 0;
    if (timeSec > totalTime) timeSec = totalTime;

    // Find the current segment
    let idx = 0;
    while (idx < stations.length - 1 && stations[idx+1].timestamp < timeSec) {
        idx++;
    }
    const currentIdx = idx;
    const nextIdx = idx + 1;

    // Interpolate fraction safely
    let fraction = 0;
    if (nextIdx < stations.length) {
        const t1 = stations[currentIdx].timestamp;
        const t2 = stations[nextIdx].timestamp;
        if (t2 > t1) {
            fraction = (timeSec - t1) / (t2 - t1);
            fraction = Math.max(0, Math.min(1, fraction)); // clamp to [0,1]
        }
    }

    // Interpolate position
    let lat, lon;
    if (nextIdx < stations.length) {
        lat = stations[currentIdx].lat + fraction * (stations[nextIdx].lat - stations[currentIdx].lat);
        lon = stations[currentIdx].lon + fraction * (stations[nextIdx].lon - stations[currentIdx].lon);
    } else {
        lat = stations[currentIdx].lat;
        lon = stations[currentIdx].lon;
    }

    trainMarker.setLatLng([lat, lon]);
    studyMap.panTo([lat, lon], { animate: true });

    // Update UI elements
    document.getElementById('current-station').innerText = stations[currentIdx].name;
    document.getElementById('next-station').innerText = nextIdx < stations.length ? stations[nextIdx].name : '终点';

    const progressPercent = (timeSec / totalTime) * 100;
    document.getElementById('progress-bar').style.width = progressPercent + '%';

    document.querySelectorAll('.route-station').forEach(el => {
        el.querySelector('.dot').classList.remove('current');
    });
    const currentEl = document.querySelector(`.route-station[data-index="${currentIdx}"]`);
    if (currentEl) currentEl.querySelector('.dot').classList.add('current');

    // Distance traveled
    let distance = cumDists[currentIdx];
    if (nextIdx < stations.length) {
        distance += fraction * (cumDists[nextIdx] - cumDists[currentIdx]);
    }
    document.getElementById('trip-dist').innerText = distance.toFixed(1);
    currentTripDistance = distance;

    // Celebration on station arrival
    if (Math.abs(timeSec - stations[currentIdx].timestamp) < 0.5 && currentIdx > 0) {
        confetti({ particleCount: 50, spread: 70, origin: { y: 0.6 } });
    }
}


function loadYouTubeVideo(videoUrl) {
    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
        document.getElementById('youtube-player').innerHTML = '<div class="empty-video">Invalid video URL</div>';
        return;
    }

    const playerDiv = document.getElementById('youtube-player');
    playerDiv.innerHTML = '';

    if (videoPlayer) videoPlayer.destroy();

    videoPlayer = new YT.Player('youtube-player', {
        height: '100%',
        width: '100%',
        videoId: videoId,
        playerVars: {
            autoplay: 1,           // start automatically
            mute: 1,                // must be muted for autoplay
            controls: 0,
            modestbranding: 1,
            rel: 0,
            showinfo: 0,
            iv_load_policy: 3,
            fs: 0,
            disablekb: 1,
            origin: window.location.origin
        },
        events: {
            onReady: onPlayerReady,
            onError: onPlayerError
        }
    });
}

function onPlayerReady(event) {
    youtubeReady = true;
    console.log('YouTube player ready');

    // Seek to first station timestamp
    if (window.firstStationTimestamp !== undefined) {
        videoPlayer.seekTo(window.firstStationTimestamp);
    }

    // Pause immediately
    if (videoPlayer && videoPlayer.pauseVideo) {
        videoPlayer.pauseVideo();
    }

    // Volume control
    const volumeSlider = document.getElementById('volume-slider');
    if (volumeSlider) {
        // Ensure video is unmuted and set initial volume to 50%
        if (videoPlayer && videoPlayer.unMute) {
            videoPlayer.unMute();
        }
        videoPlayer.setVolume(50);
        volumeSlider.value = 50;

        volumeSlider.addEventListener('input', (e) => {
            const vol = parseInt(e.target.value, 10);
            if (videoPlayer && videoPlayer.setVolume) {
                if (vol > 0 && videoPlayer.isMuted()) {
                    videoPlayer.unMute();
                }
                videoPlayer.setVolume(vol);
            }
        });
    }
}

function onPlayerError(event) {
    console.error('YouTube player error:', event.data);
    document.getElementById('youtube-player').innerHTML = `<div class="empty-video">Video error (${event.data})</div>`;
}

function extractVideoId(url) {
    const regExp = /^.*(youtu\.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
}

function completeSession() {
    pauseTimer();

    const completedTodos = todoList.filter(item => item.completed).map(item => item.text);

    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const startTime = now.toTimeString().split(' ')[0];
    const session = {
        id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
        date: dateStr,
        startTime: startTime,
        lineId: currentLine.id,
        duration: Math.round(timerSeconds / 60),
        distance: currentTripDistance || 0,
        startStation: currentLine.stations[0].name,
        endStation: currentLine.stations[currentLine.stations.length-1].name,
        completedTasks: completedTodos
    };
    userData.sessions.push(session);
    console.log('Before save, userData:', userData);
    saveUserData();

    confetti({ particleCount: 200, spread: 100, origin: { y: 0.5 } });

    setTimeout(() => {
        renderDashboard();
    }, 2000);
}

// ==================== YOUTUBE API READY ====================
window.onYouTubeIframeAPIReady = function() {
    console.log('YouTube API ready');
};