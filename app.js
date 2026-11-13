// --- Register Service Worker ---
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('./service-worker.js')
                    .then(reg => console.log('ServiceWorker registration successful: ', reg.scope))
                    .catch(err => console.log('ServiceWorker registration failed: ', err));
            });
        }

        // --- Dual Storage: localStorage (Synchronous Instant Backup) + IndexedDB ---
        const DB_NAME = 'StrataScribeDB';
        const STORE_NAME = 'projectStore';
        const DB_VERSION = 1;
        const LOCAL_STORAGE_KEY = 'strata_scribe_autosave_v1_6_10';

        function openDB() {
            return new Promise((resolve, reject) => {
                const request = indexedDB.open(DB_NAME, DB_VERSION);
                request.onerror = () => reject(request.error);
                request.onsuccess = () => resolve(request.result);
                request.upgradeneeded = (event) => {
                    const db = event.target.result;
                    if (!db.objectStoreNames.contains(STORE_NAME)) {
                        db.createObjectStore(STORE_NAME);
                    }
                };
            });
        }

        function saveLocalSync() {
            try {
                const payload = {
                    projectMeta: projectMeta,
                    borings: borings,
                    activeBoringIndex: activeBoringIndex,
                    timestamp: Date.now()
                };
                localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(payload));
            } catch (e) {
                console.error("localStorage save error:", e);
            }
        }

        async function saveToIndexedDB() {
            try {
                const db = await openDB();
                const tx = db.transaction(STORE_NAME, 'readwrite');
                const store = tx.objectStore(STORE_NAME);
                const payload = {
                    projectMeta: projectMeta,
                    borings: borings,
                    activeBoringIndex: activeBoringIndex,
                    timestamp: Date.now()
                };
                store.put(payload, 'currentProject');
                return new Promise((resolve, reject) => {
                    tx.oncomplete = () => resolve(true);
                    tx.onerror = () => reject(tx.error);
                });
            } catch (e) {
                console.error("IndexedDB save error:", e);
            }
        }

        async function saveLocal() {
            saveLocalSync(); // Instant synchronous backup on every keystroke/change
            await saveToIndexedDB(); // Asynchronous primary storage
        }

        async function loadFromIndexedDB() {
            try {
                const db = await openDB();
                const tx = db.transaction(STORE_NAME, 'readonly');
                const store = tx.objectStore(STORE_NAME);
                const request = store.get('currentProject');
                return new Promise((resolve, reject) => {
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                });
            } catch (e) {
                console.error("IndexedDB load error:", e);
                return null;
            }
        }

        async function loadLocal() {
            // 1. Try instant synchronous localStorage first
            try {
                const localData = localStorage.getItem(LOCAL_STORAGE_KEY);
                if (localData) {
                    const parsed = JSON.parse(localData);
                    if (parsed && parsed.borings) {
                        projectMeta = parsed.projectMeta || projectMeta;
                        borings = parsed.borings || borings;
                        activeBoringIndex = parsed.activeBoringIndex || 0;
                        return true;
                    }
                }
            } catch (e) {
                console.error("localStorage load error:", e);
            }

            // 2. Fallback to IndexedDB
            try {
                const saved = await loadFromIndexedDB();
                if (saved && saved.borings) {
                    projectMeta = saved.projectMeta || projectMeta;
                    borings = saved.borings || borings;
                    activeBoringIndex = saved.activeBoringIndex || 0;
                    return true;
                }
            } catch (e) {
                console.error("IndexedDB load error:", e);
            }
            return false;
        }

        // --- Save Status State & Timer Management ---
        let isSaved = true;
        let lastSaveOrBackupTime = Date.now();
        let unsavedSinceTime = null;
        let isInitialized = false;
        let backupInProgress = false; // Mutex lock to prevent multi-download bug

        function markUnsaved() {
            if (isSaved) {
                isSaved = false;
                unsavedSinceTime = Date.now();
            }
            updateSaveStatusUI();
        }

        function markSavedNow() {
            isSaved = true;
            unsavedSinceTime = null;
            lastSaveOrBackupTime = Date.now();
            updateSaveStatusUI();
        }

        function updateSaveStatusUI() {
            const indicator = document.getElementById('saveStatusIndicator');
            if (!indicator) return;
            if (isSaved) {
                indicator.className = "text-xs font-bold px-2.5 py-1.5 rounded-lg bg-slate-800 text-emerald-400 border border-slate-700 flex items-center shadow";
                indicator.innerHTML = "✅ Saved";
            } else {
                const diffMinutes = unsavedSinceTime ? Math.max(0, Math.floor((Date.now() - unsavedSinceTime) / 60000)) : 0;
                indicator.className = "text-xs font-bold px-2.5 py-1.5 rounded-lg bg-slate-800 text-amber-400 border border-slate-700 flex flex-col items-center leading-tight shadow";
                indicator.innerHTML = `<span>● Unsaved</span><span class="text-[10px] font-medium text-amber-300/80">(${diffMinutes} min)</span>`;
            }
        }

        setInterval(() => {
            if (!isSaved) {
                updateSaveStatusUI();
                checkAutomaticBackup();
            }
        }, 60000);

        function toggleToolsMenu() {
            const menu = document.getElementById('toolsDropdownMenu');
            if (menu) menu.classList.toggle('hidden');
        }

        function closeToolsMenu() {
            const menu = document.getElementById('toolsDropdownMenu');
            if (menu) menu.classList.add('hidden');
        }

        window.addEventListener('click', (e) => {
            const container = document.getElementById('toolsDropdownContainer');
            if (container && !container.contains(e.target)) {
                closeToolsMenu();
            }
        });

        // --- Automatic Backup Logic (with Mutex & unsavedSinceTime eligibility) ---
        function checkAutomaticBackup() {
            if (!isSaved && unsavedSinceTime && !backupInProgress) {
                const elapsed = Date.now() - unsavedSinceTime;
                if (elapsed >= 15 * 60 * 1000) {
                    backupInProgress = true;
                    try {
                        exportJSONBackupSilently();
                    } finally {
                        backupInProgress = false;
                    }
                }
            }
        }

        function exportJSONBackupSilently() {
            const payload = {
                application: "StrataScribe",
                version: "v1.6.13",
                exportTimestamp: new Date().toISOString(),
                projectMeta: projectMeta,
                borings: borings
            };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const dlAnchor = document.createElement('a');
            dlAnchor.href = url;
            dlAnchor.download = buildExportFilename("json");
            document.body.appendChild(dlAnchor);
            dlAnchor.click();
            dlAnchor.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);

            isSaved = true;
            unsavedSinceTime = null;
            lastSaveOrBackupTime = Date.now();
            updateSaveStatusUI();
            showToast("Automatic JSON backup exported successfully.");
        }

        function toggleThemeFromTools() {
            document.documentElement.classList.toggle('dark');
            localStorage.setItem('geoTabletTheme_v1_6_9', document.documentElement.classList.contains('dark') ? 'dark' : 'light');
        }

        // --- Reference Data & Dropdowns ---
        const wholeFootOptions = Array.from({length: 151}, (_, i) => i);
        const decimalOptions = ["0.0", "0.1", "0.2", "0.3", "0.4", "0.5", "0.6", "0.7", "0.8", "0.9"];
        
        const sampleTypes = ["SS", "ST", "BULK", "GRAB", "CUTTINGS"];
        
        const sampleLengthDefaults = {
            "SS": "18\"",
            "ST": "24\"",
            "BULK": "60\"",
            "GRAB": "60\"",
            "CUTTINGS": "60\""
        };
        
        const offsetOptions = Array.from({length: 501}, (_, i) => String(i));
        
        const blowOptions = [
            "",
            ...Array.from({length: 51}, (_, i) => String(i)),
            '50/0"', '50/1"', '50/2"', '50/3"', '50/4"', '50/5"'
        ];

        const uscsList = ["CL", "CH", "CL-ML", "ML", "MH", "OL", "OH", "PT", "SW", "SP", "SM", "SC", "SW-SM", "SW-SC", "SP-SM", "SP-SC", "GW", "GP", "GM", "GC", "GW-GM", "GW-GC", "GP-GM", "GP-GC", "ROCK", "TOPSOIL", "ASPHALT", "FILL"];
        const coarseUSCS = ["GW","GW-GM","GW-GC","GP","GP-GM","GP-GC","GM","GC","SW","SW-SM","SW-SC","SP","SP-SM","SP-SC","SM","SC"];
        const gradationList = ["", "FINE GRAINED", "MEDIUM GRAINED", "COARSE GRAINED", "FINE TO MEDIUM GRAINED", "MEDIUM TO COARSE GRAINED"];

        const majorMods = ["", "WITH SAND AND GRAVEL", "WITH SAND", "SANDY", "WITH GRAVEL", "GRAVELLY", "SANDY WITH GRAVEL", "GRAVELLY WITH SAND", "WITH CLAY", "CLAYEY", "WITH SILT", "SILTY", "SILTY-CLAYEY"];
        const minorMods = ["", "TRACE SAND AND GRAVEL", "TRACE CLAY", "TRACE SILT", "TRACE SAND", "TRACE GRAVEL", "WITH COBBLES", "WITH ORGANICS"];
        
        const moistureList = ["DRY", "MOIST", "WET"];
        const mottlingList = [
            "",
            "YES"
        ];

        const shades = ["", "LIGHT", "DARK"];
        const colorPalette = ["", "BROWN", "RED BROWN", "TAN", "GRAY", "BLACK", "WHITE", "ORANGE", "YELLOW", "GREEN", "BLUE"];
        
        const origins = ["", "FILL", "RESIDUUM", "COLLUVIUM", "ALLUVIUM", "TILL", "MARINE SEDIMENTS", "COASTAL PLAIN", "LOESS", "ORGANIC", "VOLCANIC ASH", "TUFF", "WEATHERED ROCK", "BEDROCK", "LIMESTONE", "DOLOMITE", "CHALK"];

        const monthNames = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

        const surfaceConditionTypes = [
            "Asphalt", "Concrete", "Mineral Aggregate Base", "Crushed Stone Base", "Base Stone", "Shot Rock", "Gravel Surface", "Chip Seal", "Asphalt Millings", "Topsoil", "Mulch", "Landscaping Rock", "Riprap", "Structural Fill", "Existing Fill", "Brick", "Pavement", "Sidewalk", "Crushed Concrete", "Flowable Fill", "Peat", "Organics", "Debris", "Cinders", "Slag", "Coal Ash", "Other (Custom)"
        ];

        // --- Rock Reference Lists ---
        const rockTypes = ["LIMESTONE", "DOLOMITE", "SHALE", "SANDSTONE", "SILTSTONE", "MUDSTONE", "CHERT", "MARL", "SLATE", "PHYLLITE", "SCHIST", "GNEISS", "QUARTZITE", "GRANITE", "BASALT", "RHYOLITE", "CONGLOMERATE", "BRECCIA", "COAL", "VOID", "CAVITY", "OTHER"];
        const rockWeathering = ["FRESH", "SLIGHTLY WEATHERED", "MODERATELY WEATHERED", "HIGHLY WEATHERED", "COMPLETELY WEATHERED", "RESIDUAL SOIL"];
        const rockGrainSize = ["VERY FINE GRAINED", "FINE GRAINED", "MEDIUM GRAINED", "COARSE GRAINED", "VERY COARSE GRAINED"];
        const rockGrainShape = ["ANGULAR", "SUBANGULAR", "SUBROUNDED", "ROUNDED", "WELL ROUNDED"];
        const rockStrength = ["EXTREMELY WEAK", "VERY WEAK", "WEAK", "MEDIUM STRONG", "STRONG", "VERY STRONG", "EXTREMELY STRONG"];
        const rockBedding = ["LAMINATED", "THINLY LAMINATED", "VERY THINLY BEDDED (< 1\")", "THINLY BEDDED (1\" - 4\")", "THICKLY BEDDED (4\" - 12\")", "VERY THICKLY BEDDED (> 12\")", "MASSIVE"];
        const rockJointType = ["JOINT", "BEDDING", "FOLIATION", "SHEAR", "FAULT", "VEIN"];
        const rockJointSpacing = ["VERY CLOSE", "CLOSE", "MODERATE", "WIDE", "EXTREMELY WIDE"];
        const rockJointPersistence = ["VERY LOW (<3 FT)", "LOW (3-10 FT)", "MODERATE (10-33 FT)", "HIGH (33-66 FT)", "VERY HIGH (>66 FT)"];
        const rockRoughness = ["SLICKENSIDED", "SMOOTH", "SLIGHTLY ROUGH", "ROUGH", "VERY ROUGH"];
        const rockGeometry = ["PLANAR", "WAVY", "STEPPED", "IRREGULAR"];
        const rockAperture = ["VERY TIGHT", "TIGHT", "PARTLY OPEN", "OPEN", "MODERATELY OPEN", "WIDE", "VERY WIDE", "EXTREMELY WIDE", "CAVERNOUS"];
        const rockFilling = ["", "CLAY FILLED", "CALCITE FILLED", "SAND FILLED", "SILT FILLED", "IRON OXIDE FILLED", "MANGANESE OXIDE FILLED", "GOUGE FILLED"];
        const rockGWCondition = ["DRY", "DAMP", "WET", "DRIPPING", "FLOWING"];

        const rockAdditionalCategories = {
            "Composition": ["CALCAREOUS", "DOLOMITIC", "ARGILLACEOUS", "SILICEOUS", "CHERTY", "SANDY", "MICACEOUS", "CARBONACEOUS", "FOSSILIFEROUS", "PYRITIC", "FERRUGINOUS", "QUARTZITIC"],
            "Structural Condition": ["FRACTURED", "HIGHLY FRACTURED", "HIGHLY FRAGMENTED", "SHATTERED", "BRECCIATED", "BLOCKY", "RUBBLY", "DISINTEGRATED"],
            "Structural Features": ["FOLDED", "CONTORTED", "FAULTED", "SHEARED", "SHEAR ZONE", "FAULT GOUGE"],
            "Solution Features": ["VUGGY", "VOIDS", "CAVITIES", "KARSTIC", "SOLUTION ENLARGED", "PINNACLED"],
            "Discontinuity Features": ["OPEN JOINTS", "HEALED JOINTS", "CALCITE-COATED", "CLAY-COATED", "IRON STAINED", "OXIDIZED", "POLISHED"],
            "Veining": ["CALCITE VEINS", "QUARTZ VEINS", "PYRITE VEINS"],
            "Groundwater Indicators": ["SEEPAGE", "WATER BEARING"],
            "Core Condition": ["BROKEN CORE", "RUBBLE CORE", "CORE LOSS", "DISCING", "POOR RECOVERY"],
            "GSI Structure": ["INTACT", "MASSIVE", "BLOCKY", "VERY BLOCKY", "DISTURBED", "DISINTEGRATED", "LAMINATED", "SHEARED"]
        };

        const offsetSel = document.getElementById('boringOffset');
        if (offsetSel) {
            offsetSel.innerHTML = offsetOptions.map(o => `<option value="${o}">${o} ft</option>`).join('');
        }

        // --- Session State ---
        let projectMeta = { client: "", name: "", number: "" };
        let activeBoringIndex = 0;

        let borings = [
            {
                id: "B-01",
                rig: "", driller: "", logger: "", additionalNotes: "",
                gpsLat: "", gpsLon: "", gpsAccuracy: "", gpsElevation: "", gpsTimestamp: "", gpsSource: "", gpsLocked: false,
                totalDepth: "0.0", offset: "0", direction: "N/A",
                startDate: "", endDate: "",
                terminationReason: "Completed at Planned Depth",
                refusalType: "None", refusalDepth: "",
                methods: [], surfaceConditions: [],
                gw: [
                    { depth: "", time: "N/A", customTime: "" },
                    { depth: "", time: "N/A", customTime: "" },
                    { depth: "", time: "N/A", customTime: "" }
                ],
                samples: [], rockSamples: []
            }
        ];

        if (localStorage.getItem('geoTabletTheme_v1_6_9') === 'dark') document.documentElement.classList.add('dark');

        function showToast(msg) {
            const toast = document.getElementById('toast');
            toast.textContent = msg;
            toast.classList.remove('translate-y-20', 'opacity-0');
            setTimeout(() => toast.classList.add('translate-y-20', 'opacity-0'), 2200);
        }

        function formatExportDate(d = new Date()) {
            const day = String(d.getDate()).padStart(2, '0');
            const mmm = monthNames[d.getMonth()];
            const yyyy = d.getFullYear();
            return `${day}${mmm}${yyyy}`;
        }

        function formatExportTime(d = new Date()) {
            let hours = d.getHours();
            const minutes = String(d.getMinutes()).padStart(2, '0');
            const ampm = hours >= 12 ? 'PM' : 'AM';
            hours = hours % 12;
            hours = hours ? hours : 12;
            return `${hours}${minutes}${ampm}`;
        }

        function sanitizeFilenamePart(str) {
            if (!str) return "Project";
            return str.replace(/\s+/g, '').replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 40);
        }

        function buildExportFilename(extension) {
            const now = new Date();
            const ext = extension.startsWith('.') ? extension.substring(1) : extension;
            const projName = sanitizeFilenamePart(projectMeta.name) || "Project";
            const projNum = sanitizeFilenamePart(projectMeta.number) || "000";
            return `StrtScrb.${projName}.${formatExportDate(now)}.${formatExportTime(now)}.${projNum}.${ext}`;
        }

        function parseBoringId(idStr) {
            const cleaned = (idStr || "B-01").trim();
            const match = cleaned.match(/^([A-Za-z-]+?)(\d+)$/);
            if (match) {
                return { prefix: match[1].toUpperCase(), number: parseInt(match[2], 10) };
            }
            const numMatch = cleaned.match(/\d+/);
            const num = numMatch ? parseInt(numMatch[0], 10) : 0;
            const pref = cleaned.replace(/\d+/g, '').toUpperCase() || 'B-';
            return { prefix: pref, number: num };
        }

        function compareBoringIds(aId, bId) {
            const parsedA = parseBoringId(aId);
            const parsedB = parseBoringId(bId);
            if (parsedA.prefix !== parsedB.prefix) {
                return parsedA.prefix.localeCompare(parsedB.prefix);
            }
            return parsedA.number - parsedB.number;
        }

        function parseBlow(val) {
            if (!val) return null;
            if (val.includes('/')) return 'REF';
            const num = parseInt(val);
            return isNaN(num) ? null : num;
        }

        function computeN(b2Val, b3Val, b1Val = "") {
            const v1 = parseBlow(b1Val);
            const v2 = parseBlow(b2Val);
            const v3 = parseBlow(b3Val);
            if (v1 === 'REF' || v2 === 'REF' || v3 === 'REF') return "Refusal";
            if (!b2Val && !b3Val) return "";
            if (v2 !== null && v3 !== null) return v2 + v3;
            if (v2 !== null) return v2;
            if (v3 !== null) return v3;
            return "";
        }

        function computeConsistencyDensity(nVal, uscs) {
            if (nVal === "" || nVal === null || nVal === undefined) return "";
            const isCoarse = coarseUSCS.includes(uscs);
            const n = (nVal === "Refusal") ? 999 : parseInt(nVal);

            if (isCoarse) {
                if (n < 4) return "VERY LOOSE";
                if (n < 10) return "LOOSE";
                if (n < 30) return "MEDIUM DENSE";
                if (n < 50) return "DENSE";
                return "VERY DENSE";
            } else {
                if (n < 2) return "VERY SOFT";
                if (n < 4) return "SOFT";
                if (n < 8) return "FIRM";
                if (n < 15) return "STIFF";
                if (n < 30) return "VERY STIFF";
                return "HARD";
            }
        }

        function formatColorsString(colorsArray) {
            if (!colorsArray || colorsArray.length === 0) return "";
            return colorsArray.map(c => c.toUpperCase()).join(" TO ");
        }

        function normalizeMultiRockValues(val) {
            if (Array.isArray(val)) {
                return val.map(v => String(v).trim()).filter(v => v !== "");
            }
            if (typeof val === 'string' && val.trim() !== '') {
                return val.split(',').map(v => v.trim()).filter(v => v !== "");
            }
            return [];
        }

        function formatMultiRockField(val) {
            return normalizeMultiRockValues(val).map(v => v.toUpperCase()).join(', ');
        }

        function buildSoilDescription(sample, effectiveAttributes) {
            const parts = [];
            if (effectiveAttributes.origin && effectiveAttributes.origin !== '') parts.push(effectiveAttributes.origin.toUpperCase());
            
            let uscsPart = effectiveAttributes.uscs || "";
            const isCoarse = coarseUSCS.includes(effectiveAttributes.uscs);
            if (isCoarse && effectiveAttributes.gradation && effectiveAttributes.gradation !== '') {
                uscsPart += `, ${effectiveAttributes.gradation}`;
            }
            if (effectiveAttributes.major && effectiveAttributes.major !== '') uscsPart += ` ${effectiveAttributes.major}`;
            if (uscsPart.trim()) parts.push(uscsPart.trim().toUpperCase());

            if (effectiveAttributes.minor && effectiveAttributes.minor !== '') parts.push(effectiveAttributes.minor.toUpperCase());
            
            const nVal = computeN(sample.b2, sample.b3, sample.b1);
            const density = computeConsistencyDensity(nVal, effectiveAttributes.uscs);
            if (density) parts.push(density.toUpperCase());

            if (effectiveAttributes.moisture && effectiveAttributes.moisture !== '') parts.push(effectiveAttributes.moisture.toUpperCase());

            const colorStr = formatColorsString(effectiveAttributes.colors);
            if (colorStr) parts.push(colorStr);

            return parts.join(", ");
        }

        function buildRockDescription(r) {
            const parts = [];
            if (r.rockType && r.rockType !== '') parts.push(r.rockType.toUpperCase());
            
            const colorStr = formatColorsString(r.colors);
            if (colorStr) parts.push(colorStr);

            const weatheringStr = formatMultiRockField(r.weathering);
            if (weatheringStr) parts.push(weatheringStr);

            const grainSizeStr = formatMultiRockField(r.grainSize);
            if (grainSizeStr) parts.push(grainSizeStr);

            const grainShapeStr = formatMultiRockField(r.grainShape);
            if (grainShapeStr) parts.push(grainShapeStr);

            const strengthStr = formatMultiRockField(r.strength);
            if (strengthStr) parts.push(strengthStr);

            const beddingStr = formatMultiRockField(r.bedding);
            if (beddingStr) parts.push(beddingStr);

            if (r.jointType && r.jointType !== '') parts.push(r.jointType.toUpperCase());
            if (r.jointSpacing && r.jointSpacing !== '') parts.push(`${r.jointSpacing.toUpperCase()} SPACED`);
            if (r.jointPersistence && r.jointPersistence !== '') parts.push(`PERSISTENCE ${r.jointPersistence.toUpperCase()}`);
            if (r.jointRoughness && r.jointRoughness !== '') parts.push(r.jointRoughness.toUpperCase());
            if (r.jointGeometry && r.jointGeometry !== '') parts.push(r.jointGeometry.toUpperCase());
            if (r.jointAperture && r.jointAperture !== '') parts.push(`APERTURE ${r.jointAperture.toUpperCase()}`);
            if (r.jointFilling && r.jointFilling !== '') parts.push(r.jointFilling.toUpperCase());
            if (r.gwCondition && r.gwCondition !== '') parts.push(r.gwCondition.toUpperCase());
            if (r.natFractures !== undefined && r.natFractures !== "" && r.natFractures !== "0") parts.push(`${r.natFractures} NAT. FRACTURES/FT`);
            if (r.descriptors && r.descriptors.length > 0) {
                parts.push(r.descriptors.map(d => d.toUpperCase()).join(', '));
            }
            return parts.length > 0 ? parts.join(', ') : "CLICK TO EDIT PROPERTIES...";
        }

        function getGWProfileLabel(gw) {
            if (!gw || !gw.time) return "";
            if (gw.time === 'Other') return gw.customTime ? gw.customTime.toUpperCase() : 'OTHER';
            const labels = {
                "ATD": "GW: ATD",
                "AD": "GW: AD",
                "Next Day": "GW: ND",
                "Cave In": "GW: CI",
                "After Coring": "GW: AC",
                "After Mud Rotary": "GW: AMR",
                "N/E": "GW: NE",
                "N/A": "GW: NA",
                "Other": "GW: NOTE"
            };
            return labels[gw.time] || "GW";
        }

        function syncGPSLockUI() {
            const cur = borings[activeBoringIndex];
            const isLocked = Boolean(cur && cur.gpsLocked);
            const toggle = document.getElementById('gpsLockToggle');
            const label = document.getElementById('gpsLockLabel');
            const btn = document.getElementById('getGpsBtn');

            if (toggle) toggle.checked = isLocked;
            if (btn) btn.disabled = isLocked;
            if (label) {
                if (isLocked) {
                    label.className = "ms-2 text-[11px] font-bold text-amber-600 dark:text-amber-400 flex items-center space-x-1";
                    label.innerHTML = `<i data-lucide="lock" class="w-3 h-3 text-amber-500"></i><span>GPS Locked</span>`;
                } else {
                    label.className = "ms-2 text-[11px] font-bold text-slate-600 dark:text-slate-300 flex items-center space-x-1";
                    label.innerHTML = `<i data-lucide="unlock" class="w-3 h-3 text-slate-400"></i><span>Unlocked</span>`;
                }
                if (typeof lucide !== 'undefined') lucide.createIcons();
            }
        }

        function toggleGPSLock(locked) {
            const cur = borings[activeBoringIndex];
            if (!cur) return;
            cur.gpsLocked = Boolean(locked);
            syncGPSLockUI();
            markUnsaved();
            saveLocal();
            showToast(cur.gpsLocked ? "GPS location locked." : "GPS location unlocked.");
        }

        function getBoringGPS() {
            const cur = borings[activeBoringIndex];
            if (cur && cur.gpsLocked) {
                showToast("GPS location is locked. Unlock it first to update.");
                return;
            }
            if (!navigator.geolocation) {
                alert("Geolocation is not supported by your browser");
                return;
            }
            cur.gpsLat = ""; cur.gpsLon = ""; cur.gpsAccuracy = "";
            syncHeaderUI();
            showToast("Retrieving GPS location...");

            navigator.geolocation.getCurrentPosition((position) => {
                const lat = position.coords.latitude.toFixed(6);
                const lon = position.coords.longitude.toFixed(6);
                const accuracy = position.coords.accuracy ? `±${Math.round(position.coords.accuracy * 3.28084)} ft` : "";
                const elevation = position.coords.altitude !== null ? `${(position.coords.altitude * 3.28084).toFixed(1)} ft` : "";
                const timestamp = new Date(position.timestamp || Date.now()).toISOString();

                cur.gpsLat = lat;
                cur.gpsLon = lon;
                cur.gpsAccuracy = accuracy;
                cur.gpsElevation = elevation;
                cur.gpsTimestamp = timestamp;
                cur.gpsSource = "Device GPS";
                cur.gpsLocked = true;

                syncHeaderUI();
                markUnsaved();
                saveLocal();
                showToast("GPS location acquired and locked.");
            }, (error) => {
                cur.gpsLat = ""; cur.gpsLon = ""; cur.gpsAccuracy = "";
                syncHeaderUI();
                alert("Unable to retrieve your location: " + error.message);
            }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
        }

        function recalculateTotalDepth() {
            const cur = borings[activeBoringIndex];
            if (!cur) return;
            let maxDepth = parseFloat(cur.totalDepth) || 0;

            let cumulativeDepth = 0;
            if (cur.surfaceConditions) {
                cur.surfaceConditions.forEach(sc => {
                    const thickInches = parseFloat(sc.thickness) || 0;
                    cumulativeDepth += thickInches / 12.0;
                });
            }

            if (cur.samples) {
                cur.samples.forEach(s => {
                    const top = parseFloat(s.whole) + parseFloat(s.dec);
                    const lenStr = String(s.length || "18").replace(/[^0-9.]/g, '');
                    const lenInches = parseFloat(lenStr) || 18.0;
                    const lenFeet = lenInches / 12.0;
                    if (top + lenFeet > maxDepth) maxDepth = top + lenFeet;
                });
            }
            if (cur.rockSamples) {
                cur.rockSamples.forEach(r => {
                    const top = parseFloat(r.whole) + parseFloat(r.dec);
                    const runLen = parseFloat(r.runLength) || 0;
                    if (top + runLen > maxDepth) maxDepth = top + runLen;
                });
            }

            cur.totalDepth = maxDepth.toFixed(1);
            const tdInput = document.getElementById('totalDepth');
            if (tdInput) tdInput.value = cur.totalDepth;
        }

        function onManualTotalDepthChange(val) {
            borings[activeBoringIndex].totalDepth = val;
            recalculateTotalDepth();
            markUnsaved();
            saveLocal();
        }

        function formatBoringId(prefix, num) {
            return `${prefix}-${String(num).padStart(2, '0')}`;
        }

        function updateBoringSelector() {
            const sel = document.getElementById('boringSelector');
            if (!sel) return;
            const sortedIndices = borings.map((b, idx) => ({b, idx})).sort((x, y) => compareBoringIds(x.b.id, y.b.id));
            sel.innerHTML = sortedIndices.map(item => 
                `<option value="${item.idx}" ${item.idx === activeBoringIndex ? 'selected' : ''}>${item.b.id || 'B-01'}</option>`
            ).join('');
        }

        function switchBoring(index) {
            activeBoringIndex = parseInt(index);
            syncHeaderUI();
            renderTables();
        }

        function addNewBoring() {
            const curBoring = borings[activeBoringIndex];
            const parsed = parseBoringId(curBoring ? curBoring.id : "B-01");
            const prefix = parsed.prefix.replace(/-$/, '');
            
            const existingNums = borings.filter(b => parseBoringId(b.id).prefix.includes(prefix)).map(b => parseBoringId(b.id).number);
            const nextNum = existingNums.length > 0 ? Math.max(...existingNums) + 1 : borings.length + 1;
            const newBoringId = formatBoringId(prefix || 'B', nextNum);
            
            const newBoring = {
                id: newBoringId,
                rig: curBoring ? (curBoring.rig || "") : "",
                driller: curBoring ? (curBoring.driller || "") : "",
                logger: curBoring ? (curBoring.logger || "") : "",
                additionalNotes: "",
                gpsLat: "", gpsLon: "", gpsAccuracy: "", gpsElevation: "", gpsTimestamp: "", gpsSource: "", gpsLocked: false,
                totalDepth: "0.0", offset: "0", direction: "N/A",
                startDate: "", endDate: "",
                terminationReason: "Completed at Planned Depth",
                refusalType: "None", refusalDepth: "",
                methods: [], surfaceConditions: [],
                gw: [
                    { depth: "", time: "N/A", customTime: "" },
                    { depth: "", time: "N/A", customTime: "" },
                    { depth: "", time: "N/A", customTime: "" }
                ],
                samples: [], rockSamples: []
            };
            borings.push(newBoring);
            activeBoringIndex = borings.length - 1;
            updateBoringSelector();
            syncHeaderUI();
            renderTables();
            markUnsaved();
        }

        function deleteCurrentBoring() {
            if (borings.length <= 1) {
                showToast("Cannot delete the only boring log.");
                return;
            }
            const deletedId = borings[activeBoringIndex].id;
            if (confirm("Are you sure you want to delete the current boring?")) {
                borings.splice(activeBoringIndex, 1);
                if (activeBoringIndex >= borings.length) activeBoringIndex = borings.length - 1;
                updateBoringSelector();
                syncHeaderUI();
                renderTables();
                markUnsaved();
                showToast(`Deleted ${deletedId}`);
            }
        }

        function confirmResetAll() {
            if (confirm("Are you sure you want to delete all borings and project information?")) {
                const promptVal = prompt("Are you sure you want to delete all borings and project information?\n\nType \"YES\" to confirm:");
                if (promptVal && promptVal.trim() === "YES") {
                    localStorage.removeItem('geoTabletLog_v1_6_9');
                    localStorage.removeItem(LOCAL_STORAGE_KEY);
                    projectMeta = { client: "", name: "", number: "" };
                    borings = [{
                        id: "B-01", rig: "", driller: "", logger: "", additionalNotes: "", gpsLat: "", gpsLon: "", gpsAccuracy: "", gpsElevation: "", gpsTimestamp: "", gpsSource: "", gpsLocked: false, totalDepth: "0.0", offset: "0", direction: "N/A", startDate: "", endDate: "", terminationReason: "Completed at Planned Depth", refusalType: "None", refusalDepth: "", methods: [], surfaceConditions: [],
                        gw: [{depth:"", time:"N/A", customTime:""}, {depth:"", time:"N/A", customTime:""}, {depth:"", time:"N/A", customTime:""}],
                        samples: [], rockSamples: []
                    }];
                    activeBoringIndex = 0;
                    updateBoringSelector();
                    syncHeaderUI();
                    renderTables();
                    markUnsaved();
                    showToast("All project data has been reset.");
                } else {
                    showToast("Reset canceled.");
                }
            }
        }

        function updateProjectMeta(field, val) {
            projectMeta[field] = val;
            markUnsaved();
            saveLocal();
        }

        function updateActiveBoringHeader(field, val) {
            borings[activeBoringIndex][field] = val;
            if (field === 'id') updateBoringSelector();
            markUnsaved();
            saveLocal();
        }

        function addDrillingMethod() {
            const picker = document.getElementById('drillMethodPicker');
            const val = picker.value;
            if (!val) return;
            const curMethods = borings[activeBoringIndex].methods || [];
            if (!curMethods.includes(val)) {
                curMethods.push(val);
                borings[activeBoringIndex].methods = curMethods;
                renderDrillingBadges();
                markUnsaved();
                saveLocal();
            }
            picker.value = "";
        }

        function removeDrillingMethod(methodName) {
            const curMethods = borings[activeBoringIndex].methods || [];
            borings[activeBoringIndex].methods = curMethods.filter(m => m !== methodName);
            renderDrillingBadges();
            markUnsaved();
            saveLocal();
        }

        function renderDrillingBadges() {
            const container = document.getElementById('drillMethodsBadges');
            if (!container) return;
            const curMethods = borings[activeBoringIndex].methods || [];
            if (curMethods.length === 0) {
                container.innerHTML = `<span class="text-[11px] text-slate-400 italic">No methods added yet.</span>`;
                return;
            }
            container.innerHTML = curMethods.map(m => `
                <span class="inline-flex items-center bg-amber-500/15 dark:bg-amber-500/20 text-amber-800 dark:text-amber-300 border border-amber-500/30 text-[11px] font-semibold px-2 py-0.5 rounded-md shadow-sm">
                    ${m}
                    <button type="button" onclick="removeDrillingMethod('${m}')" class="ml-1.5 text-amber-700 dark:text-amber-400 hover:text-rose-600 font-bold px-1">&times;</button>
                </span>
            `).join('');
        }

        function updateActiveBoringGW(index, field, val) {
            if (!borings[activeBoringIndex].gw[index]) {
                borings[activeBoringIndex].gw[index] = { depth: "", time: "N/A", customTime: "" };
            }
            borings[activeBoringIndex].gw[index][field] = val;
            updateLiveProfile();
            markUnsaved();
            saveLocal();
        }

        function onGWTypeChange(index, val) {
            updateActiveBoringGW(index, 'time', val);
            const customWrap = document.getElementById(`gwCustomWrap${index+1}`);
            if (val === 'Other') customWrap.classList.remove('hidden');
            else customWrap.classList.add('hidden');
        }

        function syncHeaderUI() {
            document.getElementById('projectClient').value = projectMeta.client || "";
            document.getElementById('projectName').value = projectMeta.name || "";
            document.getElementById('projectNumber').value = projectMeta.number || "";

            const cur = borings[activeBoringIndex];
            document.getElementById('boringId').value = cur.id || "";
            document.getElementById('drillRig').value = cur.rig || "";
            document.getElementById('drillerName').value = cur.driller || "";
            document.getElementById('loggerName').value = cur.logger || "";
            document.getElementById('additionalBoringNotes').value = cur.additionalNotes || "";
            document.getElementById('gpsLat').value = cur.gpsLat || "";
            document.getElementById('gpsLon').value = cur.gpsLon || "";
            document.getElementById('gpsAccuracy').value = cur.gpsAccuracy || "";
            syncGPSLockUI();
            document.getElementById('totalDepth').value = cur.totalDepth || "0.0";
            document.getElementById('boringOffset').value = cur.offset || "0";
            document.getElementById('boringDirection').value = cur.direction || "N/A";
            document.getElementById('terminationReason').value = cur.terminationReason || "Completed at Planned Depth";
            document.getElementById('refusalType').value = cur.refusalType || "None";
            document.getElementById('refusalDepth').value = cur.refusalDepth || "";
            document.getElementById('startDate').value = cur.startDate || "";
            document.getElementById('endDate').value = cur.endDate || "";

            renderDrillingBadges();

            for (let i = 0; i < 3; i++) {
                const gw = cur.gw && cur.gw[i] ? cur.gw[i] : { depth: "", time: "N/A", customTime: "" };
                document.getElementById(`gwDepth${i+1}`).value = gw.depth || "";
                document.getElementById(`gwTime${i+1}`).value = gw.time || "N/A";
                const customWrap = document.getElementById(`gwCustomWrap${i+1}`);
                const customInput = document.getElementById(`gwCustom${i+1}`);
                customInput.value = gw.customTime || "";
                if (gw.time === 'Other') customWrap.classList.remove('hidden');
                else customWrap.classList.add('hidden');
            }
        }

        function sortActiveBoringSamples() {
            const activeBoring = borings[activeBoringIndex];
            if (!activeBoring) return;
            if (activeBoring.samples) {
                activeBoring.samples.sort((a, b) => (parseFloat(a.whole) + parseFloat(a.dec)) - (parseFloat(b.whole) + parseFloat(b.dec)));
            }
            if (activeBoring.rockSamples) {
                activeBoring.rockSamples.sort((a, b) => (parseFloat(a.whole) + parseFloat(a.dec)) - (parseFloat(b.whole) + parseFloat(b.dec)));
            }
        }

        function renderTables() {
            sortActiveBoringSamples();
            renderSurfaceConditionsTable();
            renderSoilTable();
            renderRockTable();
            recalculateTotalDepth();
            updateLiveProfile();
            saveLocal();
        }

        function renderSurfaceConditionsTable() {
            const tbody = document.getElementById('surfaceConditionsTbody');
            if (!tbody) return;
            tbody.innerHTML = '';
            const activeBoring = borings[activeBoringIndex];
            if (!activeBoring) return;
            if (!activeBoring.surfaceConditions) activeBoring.surfaceConditions = [];

            activeBoring.surfaceConditions.forEach((sc, idx) => {
                const tr = document.createElement('tr');
                tr.className = "hover:bg-slate-50 dark:hover:bg-slate-700/40 transition";
                const isCustomType = !surfaceConditionTypes.includes(sc.type) && sc.type !== "";
                const selectedTypeVal = isCustomType ? "Other (Custom)" : (sc.type || "");
                const typeOptionsHtml = surfaceConditionTypes.map(t => `<option value="${t}" ${selectedTypeVal === t ? 'selected' : ''}>${t}</option>`).join('');

                tr.innerHTML = `
                    <td class="py-2.5 px-3">
                        <input type="number" step="0.5" value="${sc.thickness || ''}" oninput="updateSurfaceCondition(${idx}, 'thickness', this.value)" placeholder="inches" class="table-input font-bold text-amber-600 text-center">
                    </td>
                    <td class="py-2.5 px-3 space-y-1">
                        <select onchange="onSurfaceConditionTypeChange(${idx}, this.value)" class="table-select font-bold">${typeOptionsHtml}</select>
                        <input type="text" id="customTypeInput_${idx}" value="${isCustomType ? sc.type : ''}" oninput="updateSurfaceCondition(${idx}, 'type', this.value)" placeholder="Specify custom type..." class="table-input text-xs ${isCustomType ? '' : 'hidden'} mt-1">
                    </td>
                    <td class="py-2.5 px-3">
                        <input type="text" value="${sc.remarks || ''}" oninput="updateSurfaceCondition(${idx}, 'remarks', this.value)" placeholder="Remarks..." class="table-input">
                    </td>
                    <td class="py-2.5 px-3 text-center">
                        <div class="flex items-center justify-center space-x-1">
                            <button onclick="moveSurfaceCondition(${idx}, -1)" ${idx === 0 ? 'disabled' : ''} class="p-1 rounded bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 disabled:opacity-30" title="Move Up"><i data-lucide="arrow-up" class="w-3.5 h-3.5"></i></button>
                            <button onclick="moveSurfaceCondition(${idx}, 1)" ${idx === activeBoring.surfaceConditions.length - 1 ? 'disabled' : ''} class="p-1 rounded bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 disabled:opacity-30" title="Move Down"><i data-lucide="arrow-down" class="w-3.5 h-3.5"></i></button>
                        </div>
                    </td>
                    <td class="py-2.5 px-3 text-center">
                        <button onclick="deleteSurfaceCondition(${idx})" class="text-rose-500 hover:text-rose-700 p-1"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
                    </td>
                `;
                tbody.appendChild(tr);
            });
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }

        function addSurfaceConditionRow() {
            const activeBoring = borings[activeBoringIndex];
            if (!activeBoring.surfaceConditions) activeBoring.surfaceConditions = [];
            activeBoring.surfaceConditions.push({ thickness: "", type: "Asphalt", remarks: "" });
            markUnsaved();
            renderTables();
        }

        function updateSurfaceCondition(idx, field, val) {
            borings[activeBoringIndex].surfaceConditions[idx][field] = val;
            markUnsaved();
            saveLocal();
        }

        function onSurfaceConditionTypeChange(idx, val) {
            const activeBoring = borings[activeBoringIndex];
            const customInput = document.getElementById(`customTypeInput_${idx}`);
            if (val === "Other (Custom)") {
                activeBoring.surfaceConditions[idx].type = customInput ? customInput.value : "";
                if (customInput) customInput.classList.remove('hidden');
            } else {
                activeBoring.surfaceConditions[idx].type = val;
                if (customInput) customInput.classList.add('hidden');
            }
            markUnsaved();
            renderTables();
        }

        function moveSurfaceCondition(idx, direction) {
            const activeBoring = borings[activeBoringIndex];
            const scList = activeBoring.surfaceConditions;
            const newIdx = idx + direction;
            if (newIdx < 0 || newIdx >= scList.length) return;
            const temp = scList[idx];
            scList[idx] = scList[newIdx];
            scList[newIdx] = temp;
            markUnsaved();
            renderTables();
        }

        function deleteSurfaceCondition(idx) {
            borings[activeBoringIndex].surfaceConditions.splice(idx, 1);
            markUnsaved();
            renderTables();
        }

        function renderSoilTable() {
            const tbody = document.getElementById('soilLogTbody');
            if (!tbody) return;
            tbody.innerHTML = '';
            const activeBoring = borings[activeBoringIndex];
            if (!activeBoring) return;

            activeBoring.samples.forEach((s, idx) => {
                const tr = document.createElement('tr');
                tr.className = "hover:bg-slate-50 dark:hover:bg-slate-700/40 transition";

                const nVal = computeN(s.b2, s.b3, s.b1);
                const autoDensity = computeConsistencyDensity(nVal, s.uscs);

                const effectiveAttrs = { 
                    origin: s.origin, uscs: s.uscs, gradation: s.gradation, major: s.major, minor: s.minor, moisture: s.moisture,
                    shade: s.shade, colors: s.colors, mottling: s.mottling, density: autoDensity 
                };

                const wholeOpts = wholeFootOptions.map(w => `<option value="${w}" ${s.whole == w ? 'selected' : ''}>${w}'</option>`).join('');
                const decOpts = decimalOptions.map(d => `<option value="${d}" ${s.dec == d ? 'selected' : ''}>${d}</option>`).join('');
                const typeOpts = sampleTypes.map(t => `<option value="${t}" ${s.type === t ? 'selected' : ''}>${t}</option>`).join('');
                
                const b1Opts = blowOptions.map(b => `<option value="${b.replace(/"/g, '&quot;')}" ${s.b1 === b ? 'selected' : ''}>${b}</option>`).join('');
                const b2Opts = blowOptions.map(b => `<option value="${b.replace(/"/g, '&quot;')}" ${s.b2 === b ? 'selected' : ''}>${b}</option>`).join('');
                const b3Opts = blowOptions.map(b => `<option value="${b.replace(/"/g, '&quot;')}" ${s.b3 === b ? 'selected' : ''}>${b}</option>`).join('');

                const soilSummary = buildSoilDescription(s, effectiveAttrs) || "Click to edit soil properties...";

                tr.innerHTML = `
                    <td class="py-2.5 px-3">
                        <div class="flex space-x-1">
                            <select onchange="updateSoilRow(${idx}, 'whole', this.value)" class="table-select font-bold w-18">${wholeOpts}</select>
                            <select onchange="updateSoilRow(${idx}, 'dec', this.value)" class="table-select w-16">${decOpts}</select>
                        </div>
                    </td>
                    <td class="py-2.5 px-3">
                        <select onchange="onSampleTypeChange(${idx}, this.value)" class="table-select font-bold">${typeOpts}</select>
                    </td>
                    <td class="py-2.5 px-3">
                        <input type="text" value="${s.length || '18\"'}" oninput="updateSoilRow(${idx}, 'length', this.value)" class="table-input font-semibold text-amber-600 dark:text-amber-400 text-center" placeholder="e.g. 18&quot;">
                    </td>
                    <td class="py-2.5 px-3"><select onchange="updateSoilRow(${idx}, 'b1', this.value)" class="table-select">${b1Opts}</select></td>
                    <td class="py-2.5 px-3"><select onchange="updateSoilRow(${idx}, 'b2', this.value)" class="table-select">${b2Opts}</select></td>
                    <td class="py-2.5 px-3"><select onchange="updateSoilRow(${idx}, 'b3', this.value)" class="table-select">${b3Opts}</select></td>
                    <td class="py-2.5 px-3 text-center font-extrabold text-amber-600 dark:text-amber-400 text-sm">${nVal}</td>
                    <td class="py-2.5 px-3">
                        <select
                            onchange="updateSoilRow(${idx}, 'rec', this.value)"
                            class="table-select text-center">
                            <option value=""></option>
                            ${Array.from({ length: 41 }, (_, i) =>
                                `<option value="${i}" ${s.rec == i ? 'selected' : ''}>${i}"</option>`
                            ).join('')}
                        </select>
                    </td>
                    <td class="py-2.5 px-3">
                        <button onclick="openSoilPropsModal(${idx})" class="w-full table-input text-left whitespace-normal break-words bg-amber-500/10 dark:bg-amber-500/20 text-amber-800 dark:text-amber-300 font-bold border border-amber-500/30 hover:bg-amber-500/25 transition flex items-center justify-between px-3 py-2 min-h-[36px]">
                            <span class="flex-1 pr-2">${soilSummary}</span>
                            <i data-lucide="edit-3" class="w-3.5 h-3.5 flex-shrink-0"></i>
                        </button>
                    </td>
                    <td class="py-2.5 px-3"><input type="text" value="${s.remarks || ''}" oninput="updateSoilRow(${idx}, 'remarks', this.value)" placeholder="Remarks..." class="table-input"></td>
                    <td class="py-2.5 px-3 text-center"><button onclick="deleteSoilRow(${idx})" class="text-rose-500 hover:text-rose-700 p-1"><i data-lucide="trash-2" class="w-4 h-4"></i></button></td>
                `;
                tbody.appendChild(tr);
            });
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }

        function onSampleTypeChange(idx, val) {
            const sample = borings[activeBoringIndex].samples[idx];
            sample.type = val;
            if (sampleLengthDefaults[val] !== undefined) {
                sample.length = sampleLengthDefaults[val];
            }
            markUnsaved();
            renderTables();
        }

        function updateSoilRow(idx, field, val) {
            borings[activeBoringIndex].samples[idx][field] = val;
            markUnsaved();
            saveLocal();
            if (['b1', 'b2', 'b3'].includes(field)) {
                renderTables();
            }
        }

        function addSoilRow() {
            const curSamples = borings[activeBoringIndex].samples;
            const last = curSamples[curSamples.length - 1];
            const nextWhole = last ? parseInt(last.whole) + 2 : 0;
            const defaultType = last ? last.type : "SS";
            
            curSamples.push({
                whole: nextWhole, dec: "0.0", type: defaultType, length: sampleLengthDefaults[defaultType] || "18\"",
                b1: "", b2: "", b3: "", rec: "", 
                uscs: last ? last.uscs : "", gradation: last ? last.gradation : "", major: last ? last.major : "", minor: last ? last.minor : "", 
                moisture: last ? last.moisture : "", shade: "", colors: last && last.colors ? [...last.colors] : [], 
                origin: last ? last.origin : "", mottling: last ? last.mottling : "", descriptors: [], remarks: ""
            });
            markUnsaved();
            renderTables();
        }

        function deleteSoilRow(idx) {
            borings[activeBoringIndex].samples.splice(idx, 1);
            markUnsaved();
            renderTables();
        }

        // --- Soil Property Modal Logic ---
        let currentModalSoilIndex = null;

        function renderChipGroup(containerId, options, currentValue, callbackName) {
            const container = document.getElementById(containerId);
            if (!container) return;
            const normCurrent = (currentValue === undefined || currentValue === null) ? "" : String(currentValue).trim();
            const fullOptions = ["", ...options.filter(o => o !== "")];

            container.innerHTML = fullOptions.map(opt => {
                const displayLabel = (opt === "") ? "-- Blank --" : opt;
                const isSelected = (String(opt).trim() === normCurrent);
                const activeClass = isSelected 
                    ? "bg-amber-500 text-slate-950 font-bold border-amber-600 shadow-sm" 
                    : "bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 border-slate-200 dark:border-slate-700 font-medium";
                const escapedOpt = opt.replace(/"/g, '&quot;').replace(/'/g, "&#39;");
                return `<button type="button" onclick="${callbackName}('${escapedOpt}')" class="px-2.5 py-1.5 rounded-lg border text-xs transition ${activeClass}">${displayLabel}</button>`;
            }).join('');
        }

        function renderMultiChipGroup(containerId, options, currentValues, callbackName) {
            const container = document.getElementById(containerId);
            if (!container) return;
            const selectedArr = normalizeMultiRockValues(currentValues);
            const fullOptions = ["", ...options.filter(o => o !== "")];

            container.innerHTML = fullOptions.map(opt => {
                const displayLabel = (opt === "") ? "-- Blank --" : opt;
                const isSelected = (opt === "") ? (selectedArr.length === 0) : selectedArr.includes(opt);
                const activeClass = isSelected 
                    ? "bg-amber-500 text-slate-950 font-bold border-amber-600 shadow-sm" 
                    : "bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 border-slate-200 dark:border-slate-700 font-medium";
                const escapedOpt = opt.replace(/"/g, '&quot;').replace(/'/g, "&#39;");
                return `<button type="button" onclick="${callbackName}('${escapedOpt}')" class="px-2.5 py-1.5 rounded-lg border text-xs transition ${activeClass}">${displayLabel}</button>`;
            }).join('');
        }

        function openSoilPropsModal(idx) {
            currentModalSoilIndex = idx;
            const s = borings[activeBoringIndex].samples[idx];

            document.getElementById('soilModalSubtitle').textContent = `Boring ${borings[activeBoringIndex].id || ''} — Depth: ${(parseFloat(s.whole) + parseFloat(s.dec)).toFixed(1)} ft`;

            renderChipGroup('chipContainer_uscs', uscsList, s.uscs || '', 'selectSoilUscs');

            const gradationSection = document.getElementById('soilGradationSection');
            if (coarseUSCS.includes(s.uscs)) {
                gradationSection.classList.remove('hidden');
                renderChipGroup('chipContainer_gradation', gradationList, s.gradation || '', 'selectSoilGradation');
            } else {
                gradationSection.classList.add('hidden');
            }

            renderChipGroup('chipContainer_major', majorMods, s.major || '', 'selectSoilMajor');
            renderChipGroup('chipContainer_minor', minorMods, s.minor || '', 'selectSoilMinor');
            renderChipGroup('chipContainer_moisture', moistureList, s.moisture || '', 'selectSoilMoisture');
            renderChipGroup('chipContainer_origin', origins, s.origin || '', 'selectSoilOrigin');
            renderChipGroup('chipContainer_soilShade', shades, s.shade || '', 'selectSoilShade');
            renderChipGroup('chipContainer_mottling', mottlingList, s.mottling || '', 'selectSoilMottling');
            
            populateSoilModalColorPicker('soilColorPicker', colorPalette, '');

            const nVal = computeN(s.b2, s.b3, s.b1);
            document.getElementById('soilModal_densityDisplay').value = computeConsistencyDensity(nVal, s.uscs) || "Auto-calculated from N-value & USCS";

            renderSoilColorChips(s.colors || []);

            document.getElementById('soilPropsModal').classList.remove('hidden');
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }

        function clearSoilPreviousDescription() {
            if (currentModalSoilIndex === null) return;
            const s = borings[activeBoringIndex].samples[currentModalSoilIndex];
            s.uscs = ""; s.gradation = ""; s.major = ""; s.minor = ""; s.moisture = ""; s.origin = ""; s.shade = ""; s.colors = []; s.mottling = "";

            renderChipGroup('chipContainer_uscs', uscsList, '', 'selectSoilUscs');
            document.getElementById('soilGradationSection').classList.add('hidden');
            renderChipGroup('chipContainer_major', majorMods, '', 'selectSoilMajor');
            renderChipGroup('chipContainer_minor', minorMods, '', 'selectSoilMinor');
            renderChipGroup('chipContainer_moisture', moistureList, '', 'selectSoilMoisture');
            renderChipGroup('chipContainer_origin', origins, '', 'selectSoilOrigin');
            renderChipGroup('chipContainer_soilShade', shades, '', 'selectSoilShade');
            renderChipGroup('chipContainer_mottling', mottlingList, '', 'selectSoilMottling');
            
            const nVal = computeN(s.b2, s.b3, s.b1);
            document.getElementById('soilModal_densityDisplay').value = computeConsistencyDensity(nVal, s.uscs) || "Auto-calculated from N-value & USCS";
            renderSoilColorChips([]);
            markUnsaved();
            renderTables();
        }

        function selectSoilUscs(val) {
            if (currentModalSoilIndex === null) return;
            const s = borings[activeBoringIndex].samples[currentModalSoilIndex];
            s.uscs = val;
            if (!coarseUSCS.includes(val)) s.gradation = "";

            const gradationSection = document.getElementById('soilGradationSection');
            if (coarseUSCS.includes(val)) {
                gradationSection.classList.remove('hidden');
                renderChipGroup('chipContainer_gradation', gradationList, s.gradation || '', 'selectSoilGradation');
            } else {
                gradationSection.classList.add('hidden');
            }

            const nVal = computeN(s.b2, s.b3, s.b1);
            document.getElementById('soilModal_densityDisplay').value = computeConsistencyDensity(nVal, s.uscs) || "Auto-calculated from N-value & USCS";
            renderChipGroup('chipContainer_uscs', uscsList, val, 'selectSoilUscs');
            markUnsaved();
            renderTables();
        }

        function selectSoilGradation(val) {
            if (currentModalSoilIndex === null) return;
            borings[activeBoringIndex].samples[currentModalSoilIndex].gradation = val;
            renderChipGroup('chipContainer_gradation', gradationList, val, 'selectSoilGradation');
            markUnsaved();
            renderTables();
        }

        function selectSoilMajor(val) {
            if (currentModalSoilIndex === null) return;
            borings[activeBoringIndex].samples[currentModalSoilIndex].major = val;
            renderChipGroup('chipContainer_major', majorMods, val, 'selectSoilMajor');
            markUnsaved();
            renderTables();
        }

        function selectSoilMinor(val) {
            if (currentModalSoilIndex === null) return;
            borings[activeBoringIndex].samples[currentModalSoilIndex].minor = val;
            renderChipGroup('chipContainer_minor', minorMods, val, 'selectSoilMinor');
            markUnsaved();
            renderTables();
        }

        function selectSoilMoisture(val) {
            if (currentModalSoilIndex === null) return;
            borings[activeBoringIndex].samples[currentModalSoilIndex].moisture = val;
            renderChipGroup('chipContainer_moisture', moistureList, val, 'selectSoilMoisture');
            markUnsaved();
            renderTables();
        }

        function selectSoilOrigin(val) {
            if (currentModalSoilIndex === null) return;
            borings[activeBoringIndex].samples[currentModalSoilIndex].origin = val;
            renderChipGroup('chipContainer_origin', origins, val, 'selectSoilOrigin');
            markUnsaved();
            renderTables();
        }

        function selectSoilShade(val) {
            if (currentModalSoilIndex === null) return;
            borings[activeBoringIndex].samples[currentModalSoilIndex].shade = val;
            renderChipGroup('chipContainer_soilShade', shades, val, 'selectSoilShade');
            markUnsaved();
            renderTables();
        }

        function selectSoilMottling(val) {
            if (currentModalSoilIndex === null) return;
            borings[activeBoringIndex].samples[currentModalSoilIndex].mottling = val;
            renderChipGroup('chipContainer_mottling', mottlingList, val, 'selectSoilMottling');
            markUnsaved();
            renderTables();
        }

        function populateSoilModalColorPicker(id, list, selectedVal) {
            const select = document.getElementById(id);
            if (!select) return;
            select.innerHTML = list.map(item => `<option value="${item}" ${item === selectedVal ? 'selected' : ''}>${item || '-- Blank --'}</option>`).join('');
        }

        function addSoilColor() {
            if (currentModalSoilIndex === null) return;
            const s = borings[activeBoringIndex].samples[currentModalSoilIndex];
            const shadeVal = s.shade || '';
            const colorPicker = document.getElementById('soilColorPicker');
            const colorVal = colorPicker.value;
            if (!colorVal) return;

            let entry = colorVal;

            if (shadeVal && shadeVal !== '') {
                entry = `${shadeVal} ${colorVal}`;
            }

            if (s.mottling === 'YES') {
                entry += ' MOTTLING';
            }

            if (!s.colors) s.colors = [];
            s.colors.push(entry);

            s.shade = "";
            s.mottling = "";
            colorPicker.value = "";
            renderChipGroup('chipContainer_soilShade', shades, s.shade, 'selectSoilShade');
            renderChipGroup('chipContainer_mottling', mottlingList, s.mottling, 'selectSoilMottling');
            renderSoilColorChips(s.colors);
            markUnsaved();
            renderTables();
        }

        function removeSoilColor(colorIndex) {
            if (currentModalSoilIndex === null) return;
            const s = borings[activeBoringIndex].samples[currentModalSoilIndex];
            s.colors.splice(colorIndex, 1);
            renderSoilColorChips(s.colors);
            markUnsaved();
            renderTables();
        }

        function renderSoilColorChips(colorsList) {
            const container = document.getElementById('soilColorsList');
            if (!container) return;
            if (colorsList.length === 0) {
                container.innerHTML = `<span class="text-[11px] text-slate-400 italic">No colors selected (Default).</span>`;
                return;
            }
            container.innerHTML = colorsList.map((c, i) => `
                <span class="inline-flex items-center bg-amber-500/15 dark:bg-amber-500/20 text-amber-800 dark:text-amber-300 border border-amber-500/30 text-[11px] font-semibold px-2 py-0.5 rounded-md shadow-sm">
                    ${i+1}. ${c}
                    <button type="button" onclick="removeSoilColor(${i})" class="ml-1.5 text-amber-700 dark:text-amber-400 hover:text-rose-600 font-bold px-1">&times;</button>
                </span>
            `).join('');
        }

        function closeSoilPropsModal() {
            currentModalSoilIndex = null;
            document.getElementById('soilPropsModal').classList.add('hidden');
        }

        // --- Simplified One-Way Recovery / RQD Conversion Logic ---
        const fractionValues = [
            { label: "0/8", value: 0.0 },
            { label: "1/8", value: 0.125 },
            { label: "1/4", value: 0.25 },
            { label: "3/8", value: 0.375 },
            { label: "1/2", value: 0.5 },
            { label: "5/8", value: 0.625 },
            { label: "3/4", value: 0.75 },
            { label: "7/8", value: 0.875 }
        ];

        const wholeInchOptionsRock = Array.from({length: 71}, (_, i) => i);

        function computeFeetFromInchesAndFraction(wholeInches, fracLabel) {
            const w = parseInt(wholeInches) || 0;
            const fObj = fractionValues.find(item => item.label === fracLabel) || { value: 0.0 };
            const totalInches = w + fObj.value;
            const rawFeet = totalInches / 12.0;
            const rounded = Math.round(rawFeet / 0.05) * 0.05;
            return rounded.toFixed(2);
        }

        function formatInchesDisplayString(wholeInches, fracLabel) {
            const w = parseInt(wholeInches) || 0;
            const f = fracLabel || "0/8";
            if (w === 0 && f === "0/8") return "0\"";
            if (f === "0/8") return `${w}"`;
            return `${w} ${f}"`;
        }

        function onRockInchOrFracChange(idx, fieldPrefix) {
            const r = borings[activeBoringIndex].rockSamples[idx];
            const wholeSel = document.getElementById(`rock_${fieldPrefix}_whole_${idx}`);
            const fracSel = document.getElementById(`rock_${fieldPrefix}_frac_${idx}`);
            const ftInput = document.getElementById(`rock_${fieldPrefix}_ft_${idx}`);

            if (!wholeSel || !fracSel || !ftInput) return;

            const newWhole = wholeSel.value;
            const newFrac = fracSel.value;
            const newFt = computeFeetFromInchesAndFraction(newWhole, newFrac);
            ftInput.value = newFt;

            if (fieldPrefix === 'rec') {
                r.recWhole = newWhole;
                r.recFrac = newFrac;
                r.recovery = newFt;
                const runLen = parseFloat(r.runLength) || 0;
                if (parseFloat(newFt) > runLen) {
                    alert("Warning: Recovery exceeds Run Length. Verify entry.");
                }
            } else if (fieldPrefix === 'rqd') {
                r.rqdWhole = newWhole;
                r.rqdFrac = newFrac;
                const recoveryVal = parseFloat(r.recovery);
                if (!isNaN(recoveryVal) && parseFloat(newFt) > recoveryVal) {
                    alert("RQD cannot exceed Recovery.");
                    r.rqd = "";
                    ftInput.value = "";
                    markUnsaved();
                    renderTables();
                    return;
                }
                r.rqd = newFt;
            }
            markUnsaved();
            renderTables();
        }

        function onRockFtChange(idx, fieldPrefix, val) {
            const r = borings[activeBoringIndex].rockSamples[idx];
            const numVal = parseFloat(val);
            if (isNaN(numVal)) return;

            if (fieldPrefix === 'rec') {
                const runLen = parseFloat(r.runLength) || 0;
                if (numVal > runLen) alert("Warning: Recovery exceeds Run Length. Verify entry.");
                r.recovery = numVal.toFixed(2);
            } else if (fieldPrefix === 'rqd') {
                const recoveryVal = parseFloat(r.recovery);
                if (!isNaN(recoveryVal) && numVal > recoveryVal) {
                    alert("RQD cannot exceed Recovery.");
                    r.rqd = "";
                    markUnsaved();
                    renderTables();
                    return;
                }
                r.rqd = numVal.toFixed(2);
            }
            markUnsaved();
            renderTables();
        }

        // --- Rock Table & Property Panel Logic ---
        let currentModalRockIndex = null;

        function renderRockTable() {
            const tbody = document.getElementById('rockLogTbody');
            if (!tbody) return;
            tbody.innerHTML = '';
            const activeBoring = borings[activeBoringIndex];
            if (!activeBoring || !activeBoring.rockSamples) return;

            activeBoring.rockSamples.forEach((r, idx) => {
                const tr = document.createElement('tr');
                tr.className = "hover:bg-slate-50 dark:hover:bg-slate-700/40 transition";

                const topVal = parseFloat(r.whole) + parseFloat(r.dec);
                const runLen = parseFloat(r.runLength) || 0;
                const bottomDepth = (topVal + runLen).toFixed(1);

                const wholeOpts = wholeFootOptions.map(w => `<option value="${w}" ${r.whole == w ? 'selected' : ''}>${w}'</option>`).join('');
                const decOpts = decimalOptions.map(d => `<option value="${d}" ${r.dec == d ? 'selected' : ''}>${d}</option>`).join('');

                const rockSummary = buildRockDescription(r);

                const recWholeOpts = wholeInchOptionsRock.map(w => `<option value="${w}" ${r.recWhole == w ? 'selected' : ''}>${w}&quot;</option>`).join('');
                const recFracOpts = fractionValues.map(f => `<option value="${f.label}" ${r.recFrac === f.label ? 'selected' : ''}>${f.label}</option>`).join('');

                const rqdWholeOpts = wholeInchOptionsRock.map(w => `<option value="${w}" ${r.rqdWhole == w ? 'selected' : ''}>${w}&quot;</option>`).join('');
                const rqdFracOpts = fractionValues.map(f => `<option value="${f.label}" ${r.rqdFrac === f.label ? 'selected' : ''}>${f.label}</option>`).join('');

                tr.innerHTML = `
                    <td class="py-2.5 px-3">
                        <div class="flex space-x-1">
                            <select onchange="updateRockTopDepth(${idx}, 'whole', this.value)" class="table-select font-bold w-18">${wholeOpts}</select>
                            <select onchange="updateRockTopDepth(${idx}, 'dec', this.value)" class="table-select w-16">${decOpts}</select>
                        </div>
                    </td>
                    <td class="py-2.5 px-3">
                        <input type="number" step="0.1" value="${r.runLength || '5.0'}" oninput="updateRockRow(${idx}, 'runLength', this.value)" class="table-input font-bold text-amber-600 text-center">
                    </td>
                    <td class="py-2.5 px-3 text-center font-extrabold text-amber-600 dark:text-amber-400 bg-amber-500/10 rounded">
                        ${bottomDepth}'
                    </td>
                    <td class="py-2.5 px-3">
                        <div class="flex space-x-1 items-center">
                            <select id="rock_rec_whole_${idx}" onchange="onRockInchOrFracChange(${idx}, 'rec')" class="table-select text-xs w-20 font-bold">${recWholeOpts}</select>
                            <select id="rock_rec_frac_${idx}" onchange="onRockInchOrFracChange(${idx}, 'rec')" class="table-select text-xs w-16 font-semibold">${recFracOpts}</select>
                            <input type="number" step="0.05" id="rock_rec_ft_${idx}" value="${r.recovery || ''}" oninput="onRockFtChange(${idx}, 'rec', this.value)" placeholder="ft" class="table-input text-center text-xs font-bold w-16">
                        </div>
                    </td>
                    <td class="py-2.5 px-3">
                        <div class="flex space-x-1 items-center">
                            <select id="rock_rqd_whole_${idx}" onchange="onRockInchOrFracChange(${idx}, 'rqd')" class="table-select text-xs w-20 font-bold">${rqdWholeOpts}</select>
                            <select id="rock_rqd_frac_${idx}" onchange="onRockInchOrFracChange(${idx}, 'rqd')" class="table-select text-xs w-16 font-semibold">${rqdFracOpts}</select>
                            <input type="number" step="0.05" id="rock_rqd_ft_${idx}" value="${r.rqd || ''}" oninput="onRockFtChange(${idx}, 'rqd', this.value)" placeholder="ft" class="table-input text-center text-xs font-bold w-16">
                        </div>
                    </td>
                    <td class="py-2.5 px-3">
                        <button onclick="openRockPropsModal(${idx})" class="w-full table-input text-left whitespace-normal break-words bg-amber-500/10 dark:bg-amber-500/20 text-amber-800 dark:text-amber-300 font-bold border border-amber-500/30 hover:bg-amber-500/25 transition flex items-center justify-between px-3 py-2 min-h-[36px]">
                            <span class="flex-1 pr-2">${rockSummary}</span>
                            <i data-lucide="edit-3" class="w-3.5 h-3.5 flex-shrink-0"></i>
                        </button>
                    </td>
                    <td class="py-2.5 px-3">
                        <input type="text" value="${r.remarks || ''}" oninput="updateRockRow(${idx}, 'remarks', this.value)" class="table-input" placeholder="Remarks...">
                    </td>
                    <td class="py-2.5 px-3 text-center">
                        <button onclick="deleteRockRow(${idx})" class="text-rose-500 hover:text-rose-700 p-1"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
                    </td>
                `;
                tbody.appendChild(tr);
            });
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }

        function updateRockTopDepth(idx, part, val) {
            const rockSample = borings[activeBoringIndex].rockSamples[idx];
            rockSample[part] = val;
            markUnsaved();
            renderTables();
        }

        function updateRockRow(idx, field, val) {
            borings[activeBoringIndex].rockSamples[idx][field] = val;
            markUnsaved();
            renderTables();
        }

        function addRockRow() {
            const activeBoring = borings[activeBoringIndex];
            const refusalDep = parseFloat(activeBoring.refusalDepth);
            if (!activeBoring.rockSamples) activeBoring.rockSamples = [];
            
            const isFirstRun = (activeBoring.rockSamples.length === 0);
            let nextTop = !isNaN(refusalDep) ? refusalDep : 0.0;
            const last = !isFirstRun ? activeBoring.rockSamples[activeBoring.rockSamples.length - 1] : null;

            if (last) {
                nextTop = (parseFloat(last.whole) + parseFloat(last.dec)) + (parseFloat(last.runLength) || 5.0);
            }

            const wholePart = Math.floor(nextTop);
            const decPart = (nextTop - wholePart).toFixed(1);

            let newRockRun = {
                whole: wholePart, dec: decPart, runLength: "5.0",
                recWhole: 0, recFrac: "0/8", recovery: "",
                rqdWhole: 0, rqdFrac: "0/8", rqd: "",
                rockType: "", shade: "", colors: [], weathering: [], grainSize: [], grainShape: [], strength: [],
                bedding: [], jointType: "", jointSpacing: "", jointPersistence: "", jointRoughness: "", jointGeometry: "",
                jointAperture: "", jointFilling: "", gwCondition: "", natFractures: "0", descriptors: [], remarks: ""
            };

            if (!isFirstRun && last) {
                newRockRun.rockType = last.rockType || "";
                newRockRun.shade = last.shade || "";
                newRockRun.colors = last.colors ? [...last.colors] : [];
                newRockRun.weathering = normalizeMultiRockValues(last.weathering);
                newRockRun.grainSize = normalizeMultiRockValues(last.grainSize);
                newRockRun.grainShape = normalizeMultiRockValues(last.grainShape);
                newRockRun.strength = normalizeMultiRockValues(last.strength);
                newRockRun.bedding = normalizeMultiRockValues(last.bedding);
                newRockRun.jointType = last.jointType || "";
                newRockRun.jointSpacing = last.jointSpacing || "";
                newRockRun.jointPersistence = last.jointPersistence || "";
                newRockRun.jointRoughness = last.jointRoughness || "";
                newRockRun.jointGeometry = last.jointGeometry || "";
                newRockRun.jointAperture = last.jointAperture || "";
                newRockRun.jointFilling = last.jointFilling || "";
                newRockRun.gwCondition = last.gwCondition || "";
                newRockRun.natFractures = last.natFractures || "0";
                newRockRun.descriptors = last.descriptors ? [...last.descriptors] : [];
            }

            activeBoring.rockSamples.push(newRockRun);
            markUnsaved();
            renderTables();
        }

        function deleteRockRow(idx) {
            borings[activeBoringIndex].rockSamples.splice(idx, 1);
            markUnsaved();
            renderTables();
        }

        function openRockPropsModal(idx) {
            currentModalRockIndex = idx;
            const r = borings[activeBoringIndex].rockSamples[idx];

            r.weathering = normalizeMultiRockValues(r.weathering);
            r.grainSize = normalizeMultiRockValues(r.grainSize);
            r.grainShape = normalizeMultiRockValues(r.grainShape);
            r.strength = normalizeMultiRockValues(r.strength);
            r.bedding = normalizeMultiRockValues(r.bedding);

            document.getElementById('rockModalSubtitle').textContent = `Boring ${borings[activeBoringIndex].id || ''} — Run Top Depth: ${(parseFloat(r.whole) + parseFloat(r.dec)).toFixed(1)} ft`;

            renderChipGroup('chipContainer_rockType', rockTypes, r.rockType || '', 'selectRockType');
            renderMultiChipGroup('chipContainer_weathering', rockWeathering, r.weathering, 'selectRockWeathering');
            renderMultiChipGroup('chipContainer_grainSize', rockGrainSize, r.grainSize, 'selectRockGrainSize');
            renderMultiChipGroup('chipContainer_grainShape', rockGrainShape, r.grainShape, 'selectRockGrainShape');
            renderMultiChipGroup('chipContainer_strength', rockStrength, r.strength, 'selectRockStrength');
            
            renderChipGroup('chipContainer_rockShade', shades, r.shade || '', 'selectRockShade');
            populateSoilModalColorPicker('rockColorPicker', colorPalette, '');

            renderMultiChipGroup('chipContainer_bedding', rockBedding, r.bedding, 'selectRockBedding');
            renderChipGroup('chipContainer_jointType', rockJointType, r.jointType || '', 'selectRockJointType');
            renderChipGroup('chipContainer_jointSpacing', rockJointSpacing, r.jointSpacing || '', 'selectRockJointSpacing');
            renderChipGroup('chipContainer_jointPersistence', rockJointPersistence, r.jointPersistence || '', 'selectRockJointPersistence');
            renderChipGroup('chipContainer_jointRoughness', rockRoughness, r.jointRoughness || '', 'selectRockJointRoughness');
            renderChipGroup('chipContainer_jointGeometry', rockGeometry, r.jointGeometry || '', 'selectRockJointGeometry');
            renderChipGroup('chipContainer_jointAperture', rockAperture, r.jointAperture || '', 'selectRockJointAperture');
            renderChipGroup('chipContainer_jointFilling', rockFilling, r.jointFilling || '', 'selectRockJointFilling');
            renderChipGroup('chipContainer_gwCondition', rockGWCondition, r.gwCondition || '', 'selectRockGwCondition');

            document.getElementById('modal_natFractures').value = r.natFractures !== undefined ? r.natFractures : "0";

            renderRockColorChips(r.colors || []);
            renderModalDescriptors(r.descriptors || []);

            document.getElementById('rockPropsModal').classList.remove('hidden');
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }

        function clearRockPreviousDescription() {
            if (currentModalRockIndex === null) return;
            const r = borings[activeBoringIndex].rockSamples[currentModalRockIndex];
            r.rockType = ""; r.weathering = []; r.grainSize = []; r.grainShape = []; r.strength = []; r.shade = ""; r.colors = []; r.bedding = []; r.jointType = ""; r.jointSpacing = ""; r.jointPersistence = ""; r.jointRoughness = ""; r.jointGeometry = ""; r.jointAperture = ""; r.jointFilling = ""; r.gwCondition = ""; r.descriptors = []; r.natFractures = "0";

            renderChipGroup('chipContainer_rockType', rockTypes, '', 'selectRockType');
            renderMultiChipGroup('chipContainer_weathering', rockWeathering, [], 'selectRockWeathering');
            renderMultiChipGroup('chipContainer_grainSize', rockGrainSize, [], 'selectRockGrainSize');
            renderMultiChipGroup('chipContainer_grainShape', rockGrainShape, [], 'selectRockGrainShape');
            renderMultiChipGroup('chipContainer_strength', rockStrength, [], 'selectRockStrength');
            renderChipGroup('chipContainer_rockShade', shades, '', 'selectRockShade');
            renderMultiChipGroup('chipContainer_bedding', rockBedding, [], 'selectRockBedding');
            renderChipGroup('chipContainer_jointType', rockJointType, '', 'selectRockJointType');
            renderChipGroup('chipContainer_jointSpacing', rockJointSpacing, '', 'selectRockJointSpacing');
            renderChipGroup('chipContainer_jointPersistence', rockJointPersistence, '', 'selectRockJointPersistence');
            renderChipGroup('chipContainer_jointRoughness', rockRoughness, '', 'selectRockJointRoughness');
            renderChipGroup('chipContainer_jointGeometry', rockGeometry, '', 'selectRockJointGeometry');
            renderChipGroup('chipContainer_jointAperture', rockAperture, '', 'selectRockJointAperture');
            renderChipGroup('chipContainer_jointFilling', rockFilling, '', 'selectRockJointFilling');
            renderChipGroup('chipContainer_gwCondition', rockGWCondition, '', 'selectRockGwCondition');

            document.getElementById('modal_natFractures').value = "0";
            renderRockColorChips([]);
            renderModalDescriptors([]);
            markUnsaved();
            renderTables();
        }

        function toggleRockMultiProperty(field, val) {
            if (currentModalRockIndex === null) return;
            const r = borings[activeBoringIndex].rockSamples[currentModalRockIndex];
            let arr = normalizeMultiRockValues(r[field]);
            if (val === "") {
                arr = [];
            } else {
                if (arr.includes(val)) {
                    arr = arr.filter(item => item !== val);
                } else {
                    arr.push(val);
                }
            }
            r[field] = arr;
            return arr;
        }

        function selectRockType(val) {
            if (currentModalRockIndex === null) return;
            borings[activeBoringIndex].rockSamples[currentModalRockIndex].rockType = val;
            renderChipGroup('chipContainer_rockType', rockTypes, val, 'selectRockType');
            markUnsaved(); renderTables();
        }
        function selectRockWeathering(val) {
            if (currentModalRockIndex === null) return;
            const updated = toggleRockMultiProperty('weathering', val);
            renderMultiChipGroup('chipContainer_weathering', rockWeathering, updated, 'selectRockWeathering');
            markUnsaved(); renderTables();
        }
        function selectRockGrainSize(val) {
            if (currentModalRockIndex === null) return;
            const updated = toggleRockMultiProperty('grainSize', val);
            renderMultiChipGroup('chipContainer_grainSize', rockGrainSize, updated, 'selectRockGrainSize');
            markUnsaved(); renderTables();
        }
        function selectRockGrainShape(val) {
            if (currentModalRockIndex === null) return;
            const updated = toggleRockMultiProperty('grainShape', val);
            renderMultiChipGroup('chipContainer_grainShape', rockGrainShape, updated, 'selectRockGrainShape');
            markUnsaved(); renderTables();
        }
        function selectRockStrength(val) {
            if (currentModalRockIndex === null) return;
            const updated = toggleRockMultiProperty('strength', val);
            renderMultiChipGroup('chipContainer_strength', rockStrength, updated, 'selectRockStrength');
            markUnsaved(); renderTables();
        }
        function selectRockShade(val) {
            if (currentModalRockIndex === null) return;
            borings[activeBoringIndex].rockSamples[currentModalRockIndex].shade = val;
            renderChipGroup('chipContainer_rockShade', shades, val, 'selectRockShade');
            markUnsaved(); renderTables();
        }
        function selectRockBedding(val) {
            if (currentModalRockIndex === null) return;
            const updated = toggleRockMultiProperty('bedding', val);
            renderMultiChipGroup('chipContainer_bedding', rockBedding, updated, 'selectRockBedding');
            markUnsaved(); renderTables();
        }
        function selectRockJointType(val) {
            if (currentModalRockIndex === null) return;
            borings[activeBoringIndex].rockSamples[currentModalRockIndex].jointType = val;
            renderChipGroup('chipContainer_jointType', rockJointType, val, 'selectRockJointType');
            markUnsaved(); renderTables();
        }
        function selectRockJointSpacing(val) {
            if (currentModalRockIndex === null) return;
            borings[activeBoringIndex].rockSamples[currentModalRockIndex].jointSpacing = val;
            renderChipGroup('chipContainer_jointSpacing', rockJointSpacing, val, 'selectRockJointSpacing');
            markUnsaved(); renderTables();
        }
        function selectRockJointPersistence(val) {
            if (currentModalRockIndex === null) return;
            borings[activeBoringIndex].rockSamples[currentModalRockIndex].jointPersistence = val;
            renderChipGroup('chipContainer_jointPersistence', rockJointPersistence, val, 'selectRockJointPersistence');
            markUnsaved(); renderTables();
        }
        function selectRockJointRoughness(val) {
            if (currentModalRockIndex === null) return;
            borings[activeBoringIndex].rockSamples[currentModalRockIndex].jointRoughness = val;
            renderChipGroup('chipContainer_jointRoughness', rockRoughness, val, 'selectRockJointRoughness');
            markUnsaved(); renderTables();
        }
        function selectRockJointGeometry(val) {
            if (currentModalRockIndex === null) return;
            borings[activeBoringIndex].rockSamples[currentModalRockIndex].jointGeometry = val;
            renderChipGroup('chipContainer_jointGeometry', rockGeometry, val, 'selectRockJointGeometry');
            markUnsaved(); renderTables();
        }
        function selectRockJointAperture(val) {
            if (currentModalRockIndex === null) return;
            borings[activeBoringIndex].rockSamples[currentModalRockIndex].jointAperture = val;
            renderChipGroup('chipContainer_jointAperture', rockAperture, val, 'selectRockJointAperture');
            markUnsaved(); renderTables();
        }
        function selectRockJointFilling(val) {
            if (currentModalRockIndex === null) return;
            borings[activeBoringIndex].rockSamples[currentModalRockIndex].jointFilling = val;
            renderChipGroup('chipContainer_jointFilling', rockFilling, val, 'selectRockJointFilling');
            markUnsaved(); renderTables();
        }
        function selectRockGwCondition(val) {
            if (currentModalRockIndex === null) return;
            borings[activeBoringIndex].rockSamples[currentModalRockIndex].gwCondition = val;
            renderChipGroup('chipContainer_gwCondition', rockGWCondition, val, 'selectRockGwCondition');
            markUnsaved(); renderTables();
        }

        function updateModalField(field, val) {
            if (currentModalRockIndex === null) return;
            borings[activeBoringIndex].rockSamples[currentModalRockIndex][field] = val;
            markUnsaved(); renderTables();
        }

        function addRockColor() {
            if (currentModalRockIndex === null) return;
            const r = borings[activeBoringIndex].rockSamples[currentModalRockIndex];
            const shadeVal = r.shade || '';
            const colorPicker = document.getElementById('rockColorPicker');
            const colorVal = colorPicker.value;
            if (!colorVal) return;

            let entry = colorVal;
            if (shadeVal && shadeVal !== '') entry = `${shadeVal} ${colorVal}`;

            if (!r.colors) r.colors = [];
            r.colors.push(entry);

            r.shade = "";
            colorPicker.value = "";
            renderChipGroup('chipContainer_rockShade', shades, r.shade, 'selectRockShade');
            renderRockColorChips(r.colors);
            markUnsaved(); renderTables();
        }

        function removeRockColor(colorIndex) {
            if (currentModalRockIndex === null) return;
            const r = borings[activeBoringIndex].rockSamples[currentModalRockIndex];
            r.colors.splice(colorIndex, 1);
            renderRockColorChips(r.colors);
            markUnsaved(); renderTables();
        }

        function renderRockColorChips(colorsList) {
            const container = document.getElementById('rockColorsList');
            if (!container) return;
            if (colorsList.length === 0) {
                container.innerHTML = `<span class="text-[11px] text-slate-400 italic">No colors selected (Default).</span>`;
                return;
            }
            container.innerHTML = colorsList.map((c, i) => `
                <span class="inline-flex items-center bg-amber-500/15 dark:bg-amber-500/20 text-amber-800 dark:text-amber-300 border border-amber-500/30 text-[11px] font-semibold px-2 py-0.5 rounded-md shadow-sm">
                    ${i+1}. ${c}
                    <button type="button" onclick="removeRockColor(${i})" class="ml-1.5 text-amber-700 dark:text-amber-400 hover:text-rose-600 font-bold px-1">&times;</button>
                </span>
            `).join('');
        }

        function renderModalDescriptors(selectedList) {
            const container = document.getElementById('modalDescriptorsContainer');
            if (!container) return;
            let html = '';
            for (const [catName, options] of Object.entries(rockAdditionalCategories)) {
                html += `
                    <div class="space-y-1 bg-slate-50 dark:bg-slate-900/50 p-3 rounded-xl border border-slate-200 dark:border-slate-800">
                        <span class="font-bold text-amber-600 dark:text-amber-400 uppercase text-[10px] tracking-wider">${catName}</span>
                        <div class="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1">
                `;
                options.forEach(opt => {
                    const isChecked = selectedList.includes(opt) ? 'checked' : '';
                    html += `
                        <label class="flex items-center space-x-2 cursor-pointer">
                            <input type="checkbox" value="${opt}" ${isChecked} onchange="onModalDescriptorToggle(this)" class="w-4 h-4 accent-amber-500 rounded">
                            <span class="text-xs font-medium text-slate-700 dark:text-slate-300">${opt}</span>
                        </label>
                    `;
                });
                html += `</div></div>`;
            }
            container.innerHTML = html;
        }

        function onModalDescriptorToggle(checkbox) {
            if (currentModalRockIndex === null) return;
            const r = borings[activeBoringIndex].rockSamples[currentModalRockIndex];
            if (!r.descriptors) r.descriptors = [];

            if (checkbox.checked) {
                if (!r.descriptors.includes(checkbox.value)) r.descriptors.push(checkbox.value);
            } else {
                r.descriptors = r.descriptors.filter(item => item !== checkbox.value);
            }
            markUnsaved(); renderTables();
        }

        function closeRockPropsModal() {
            currentModalRockIndex = null;
            document.getElementById('rockPropsModal').classList.add('hidden');
        }

        // --- Project Boring Map Modal (Online Leaflet + Offline Blank-Page Canvas Fallback, Round Markers) ---
        let boringMapInstance = null;
        let boringOfflineCanvasPoints = [];

        function getValidGPSBorings() {
            return borings.map((b, idx) => {
                const lat = parseFloat(b.gpsLat);
                const lon = parseFloat(b.gpsLon);
                if (isNaN(lat) || isNaN(lon)) return null;
                return {
                    index: idx,
                    id: b.id || `B-${String(idx + 1).padStart(2, '0')}`,
                    lat: lat,
                    lon: lon,
                    accuracy: b.gpsAccuracy || 'N/A',
                    totalDepth: b.totalDepth || '0.0',
                    rig: b.rig || 'N/A',
                    isActive: idx === activeBoringIndex
                };
            }).filter(Boolean).sort((a, b) => compareBoringIds(a.id, b.id));
        }

        function openProjectBoringMapModal() {
            const modal = document.getElementById('projectBoringMapModal');
            const mapDiv = document.getElementById('boringMap');
            const emptyState = document.getElementById('boringMapEmptyState');
            const offlineNotice = document.getElementById('boringMapOfflineNotice');
            if (!modal || !mapDiv || !emptyState) return;

            modal.classList.remove('hidden');
            const validBorings = getValidGPSBorings();

            if (boringMapInstance) {
                try { boringMapInstance.remove(); } catch (e) {}
                boringMapInstance = null;
            }
            mapDiv.innerHTML = '';

            if (validBorings.length === 0) {
                emptyState.classList.remove('hidden');
                mapDiv.classList.add('hidden');
                if (offlineNotice) offlineNotice.classList.add('hidden');
                if (typeof lucide !== 'undefined') lucide.createIcons();
                return;
            }

            emptyState.classList.add('hidden');
            mapDiv.classList.remove('hidden');

            const canUseLeaflet = (typeof L !== 'undefined') && navigator.onLine;

            if (canUseLeaflet) {
                try {
                    if (offlineNotice) offlineNotice.classList.add('hidden');
                    boringMapInstance = L.map('boringMap', { zoomControl: true });

                    const tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                        maxZoom: 19,
                        attribution: '&copy; OpenStreetMap'
                    });

                    let tileErrors = 0;
                    tileLayer.on('tileerror', () => {
                        tileErrors++;
                        if (tileErrors >= 2 && offlineNotice) {
                            offlineNotice.classList.remove('hidden');
                        }
                    });
                    tileLayer.addTo(boringMapInstance);

                    const boundsPoints = [];
                    validBorings.forEach(item => {
                        boundsPoints.push([item.lat, item.lon]);
                        const marker = L.circleMarker([item.lat, item.lon], {
                            radius: 9,
                            fillColor: item.isActive ? '#f59e0b' : '#2563eb',
                            color: '#ffffff',
                            weight: 2.5,
                            opacity: 1,
                            fillOpacity: 0.95
                        }).addTo(boringMapInstance);

                        marker.bindTooltip(item.id, {
                            permanent: true,
                            direction: 'top',
                            offset: [0, -8],
                            className: 'boring-round-label'
                        });

                        marker.bindPopup(`
                            <div style="font-size:12px;line-height:1.4;">
                                <strong>${item.id}</strong><br>
                                Lat: ${item.lat.toFixed(6)}<br>
                                Lon: ${item.lon.toFixed(6)}<br>
                                Accuracy: ${item.accuracy}<br>
                                Total Depth: ${item.totalDepth} ft
                            </div>
                        `);
                    });

                    setTimeout(() => {
                        if (!boringMapInstance) return;
                        boringMapInstance.invalidateSize();
                        if (boundsPoints.length === 1) {
                            boringMapInstance.setView(boundsPoints[0], 17);
                        } else {
                            boringMapInstance.fitBounds(L.latLngBounds(boundsPoints), { padding: [50, 50], maxZoom: 18 });
                        }
                    }, 80);
                    return;
                } catch (err) {
                    console.warn("Falling back to offline map view:", err);
                }
            }

            // Offline / Blank-Page Round Marker Canvas Renderer
            renderOfflineBlankBoringMap(mapDiv, validBorings);
            if (offlineNotice) offlineNotice.classList.remove('hidden');
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }

        function renderOfflineBlankBoringMap(container, validBorings) {
            const isDark = document.documentElement.classList.contains('dark');
            container.innerHTML = `<canvas id="offlineBoringCanvas" class="w-full h-full block cursor-pointer"></canvas>`;
            const canvas = document.getElementById('offlineBoringCanvas');
            const selLabel = document.getElementById('boringMapOfflineSelection');
            if (!canvas) return;

            const rect = container.getBoundingClientRect();
            const width = Math.max(300, Math.floor(rect.width || 800));
            const height = Math.max(300, Math.floor(rect.height || 550));
            const dpr = window.devicePixelRatio || 1;
            canvas.width = width * dpr;
            canvas.height = height * dpr;

            const ctx = canvas.getContext('2d');
            ctx.scale(dpr, dpr);

            // Clean blank background with subtle coordinate grid
            ctx.fillStyle = isDark ? '#0f172a' : '#ffffff';
            ctx.fillRect(0, 0, width, height);

            ctx.strokeStyle = isDark ? 'rgba(148, 163, 184, 0.12)' : 'rgba(100, 116, 139, 0.15)';
            ctx.lineWidth = 1;
            const gridStep = 50;
            for (let x = gridStep; x < width; x += gridStep) {
                ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
            }
            for (let y = gridStep; y < height; y += gridStep) {
                ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
            }

            // North arrow indicator
            ctx.fillStyle = isDark ? '#94a3b8' : '#475569';
            ctx.font = 'bold 11px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('N', width - 28, 22);
            ctx.beginPath();
            ctx.moveTo(width - 28, 26);
            ctx.lineTo(width - 28, 46);
            ctx.strokeStyle = isDark ? '#94a3b8' : '#475569';
            ctx.lineWidth = 1.5;
            ctx.stroke();

            const lats = validBorings.map(b => b.lat);
            const lons = validBorings.map(b => b.lon);
            const minLat = Math.min(...lats);
            const maxLat = Math.max(...lats);
            const minLon = Math.min(...lons);
            const maxLon = Math.max(...lons);
            const midLatRad = ((minLat + maxLat) / 2) * (Math.PI / 180);
            const cosLat = Math.max(0.1, Math.cos(midLatRad));

            const pad = 70;
            const plotW = Math.max(60, width - pad * 2);
            const plotH = Math.max(60, height - pad * 2);

            const spanLon = (maxLon - minLon) * cosLat;
            const spanLat = (maxLat - minLat);
            const maxSpan = Math.max(spanLon, spanLat);

            boringOfflineCanvasPoints = validBorings.map(item => {
                let cx, cy;
                if (maxSpan < 1e-8) {
                    cx = width / 2;
                    cy = height / 2;
                } else {
                    const scale = Math.min(plotW / maxSpan, plotH / maxSpan);
                    const normX = ((item.lon - minLon) * cosLat - spanLon / 2) * scale;
                    const normY = ((item.lat - minLat) - spanLat / 2) * scale;
                    cx = width / 2 + normX;
                    cy = height / 2 - normY;
                }
                return { ...item, cx, cy, r: 9 };
            });

            // Draw round markers & labels
            boringOfflineCanvasPoints.forEach(pt => {
                ctx.beginPath();
                ctx.arc(pt.cx, pt.cy, pt.r, 0, Math.PI * 2);
                ctx.fillStyle = pt.isActive ? '#f59e0b' : '#2563eb';
                ctx.fill();
                ctx.lineWidth = 2.5;
                ctx.strokeStyle = isDark ? '#0f172a' : '#ffffff';
                ctx.stroke();

                ctx.font = 'bold 12px sans-serif';
                ctx.textAlign = 'center';
                ctx.fillStyle = isDark ? '#f8fafc' : '#0f172a';
                ctx.fillText(pt.id, pt.cx, pt.cy - 14);
            });

            if (selLabel && boringOfflineCanvasPoints.length > 0) {
                const activePt = boringOfflineCanvasPoints.find(p => p.isActive) || boringOfflineCanvasPoints[0];
                selLabel.textContent = `${activePt.id}: ${activePt.lat.toFixed(6)}, ${activePt.lon.toFixed(6)} (${activePt.accuracy})`;
            }

            canvas.onclick = (evt) => {
                const cRect = canvas.getBoundingClientRect();
                const clickX = evt.clientX - cRect.left;
                const clickY = evt.clientY - cRect.top;
                const hit = boringOfflineCanvasPoints.find(p => Math.hypot(clickX - p.cx, clickY - p.cy) <= 16);
                if (hit && selLabel) {
                    selLabel.textContent = `${hit.id}: ${hit.lat.toFixed(6)}, ${hit.lon.toFixed(6)} | Accuracy: ${hit.accuracy} | Depth: ${hit.totalDepth} ft`;
                }
            };
        }

        function closeProjectBoringMapModal() {
            const modal = document.getElementById('projectBoringMapModal');
            if (modal) modal.classList.add('hidden');
            if (boringMapInstance) {
                try { boringMapInstance.remove(); } catch (e) {}
                boringMapInstance = null;
            }
        }

        // --- Geotechnical Symbology & Profile Rendering ---
        function getGeotechSymbology(code, type) {
            const s = (code || "").toUpperCase().trim();
            if (s === 'ASPHALT' || s === 'PAVEMENT' || s === 'CHIP SEAL' || s === 'ASPHALT MILLINGS') return { fill: '#09090b', hatch: 'hatch-asphalt', textColor: '#fafafa' };
            if (s === 'CONCRETE' || s === 'SIDEWALK' || s === 'FLOWABLE FILL') return { fill: '#cbd5e1', hatch: 'hatch-concrete', textColor: '#0f172a' };
            if (['MINERAL AGGREGATE BASE', 'CRUSHED STONE BASE', 'BASE STONE', 'GRAVEL SURFACE', 'CRUSHED CONCRETE', 'CINDERS', 'SLAG', 'COAL ASH'].includes(s) || s.includes('BASE') || s.includes('AGGREGATE') || s.includes('GRAVEL')) return { fill: '#94a3b8', hatch: 'hatch-gravel', textColor: '#0f172a' };
            if (s === 'SHOT ROCK') return { fill: '#334155', hatch: 'hatch-rock', textColor: '#f8fafc' };
            if (['TOPSOIL', 'MULCH', 'ORGANICS', 'PEAT'].includes(s) || s.includes('TOPSOIL') || s.includes('MULCH')) return { fill: '#b45309', hatch: 'hatch-topsoil', textColor: '#fffbeb' };
            if (s === 'RIPRAP') return { fill: '#475569', hatch: 'hatch-riprap', textColor: '#f8fafc' };
            if (['STRUCTURAL FILL', 'EXISTING FILL', 'FILL'].includes(s) || s.includes('FILL')) return { fill: '#64748b', hatch: 'hatch-fill', textColor: '#ffffff' };
            if (s === 'VOID' || s === 'CAVITY') return { fill: '#000000', hatch: 'hatch-void', textColor: '#ffffff' };
            if (type === 'ROCK' || s === 'ROCK' || ['LIMESTONE', 'DOLOMITE', 'SHALE', 'SANDSTONE', 'SILTSTONE', 'MUDSTONE', 'CHERT', 'MARL', 'SLATE', 'PHYLLITE', 'SCHIST', 'GNEISS', 'QUARTZITE', 'GRANITE', 'BASALT', 'RHYOLITE', 'CONGLOMERATE', 'BRECCIA', 'COAL'].some(r => s.includes(r))) {
                return { fill: '#cbd5e1', hatch: 'hatch-rock', textColor: '#0f172a' };
            }
            if (['GW', 'GP', 'GM', 'GC', 'GW-GM', 'GW-GC', 'GP-GM', 'GP-GC'].includes(s) || s.includes('GRAVEL')) return { fill: '#e2e8f0', hatch: 'hatch-gravel', textColor: '#0f172a' };
            if (['SW', 'SP', 'SM', 'SC', 'SW-SM', 'SW-SC', 'SP-SM', 'SP-SC'].includes(s) || s.includes('SAND')) return { fill: '#fef08a', hatch: 'hatch-sand', textColor: '#713f12' };
            if (s === 'MH') return { fill: '#3b82f6', hatch: 'hatch-silt-dark', textColor: '#ffffff' };
            if (s === 'ML' || s.includes('SILT')) return { fill: '#93c5fd', hatch: 'hatch-silt', textColor: '#1e3a8a' };
            if (s === 'CH') return { fill: '#991b1b', hatch: 'hatch-clay-high', textColor: '#fee2e2' };
            if (['CL', 'CL-ML'].includes(s) || s.includes('CLAY')) return { fill: '#fca5a5', hatch: 'hatch-clay', textColor: '#7f1d1d' };
            if (['PT', 'OH', 'OL'].includes(s) || s.includes('ORGANIC')) return { fill: '#22c55e', hatch: 'hatch-organic', textColor: '#052e16' };
            return { fill: '#d8b4fe', hatch: 'hatch-unknown', textColor: '#3b0764' };
        }

        function updateLiveProfile() {
            const curBoring = borings[activeBoringIndex];
            if (!curBoring) return;
            sortActiveBoringSamples();

            const surfaceConditions = curBoring.surfaceConditions || [];
            const soilSamples = curBoring.samples || [];
            const rockSamples = curBoring.rockSamples || [];
            const totalDepth = parseFloat(curBoring.totalDepth) || 30;

            const layers = [];
            let currentSurfaceDepth = 0.0;

            surfaceConditions.forEach(sc => {
                const thickInches = parseFloat(sc.thickness) || 0;
                const thickFeet = thickInches / 12.0;
                const layerTop = currentSurfaceDepth;
                const layerBot = currentSurfaceDepth + thickFeet;
                currentSurfaceDepth = layerBot;
                const scType = sc.type || "Surface Condition";
                layers.push({ top: layerTop, bot: layerBot, uscs: scType.toUpperCase(), type: 'SURFACE', description: `${sc.thickness || 0}" ${scType}${sc.remarks ? ' (' + sc.remarks + ')' : ''}` });
            });

            soilSamples.forEach((current, i) => {
                let layerTop = (i === 0) ? ((surfaceConditions.length > 0) ? currentSurfaceDepth : 0.0) : (parseFloat(current.whole) + parseFloat(current.dec));
                let layerBot;
                if (i < soilSamples.length - 1) {
                    layerBot = parseFloat(soilSamples[i + 1].whole) + parseFloat(soilSamples[i + 1].dec);
                } else if (rockSamples.length > 0) {
                    layerBot = parseFloat(rockSamples[0].whole) + parseFloat(rockSamples[0].dec);
                } else {
                    layerBot = Math.max(totalDepth, layerTop + 3.0);
                }
                if (layerBot < layerTop) layerBot = layerTop;

                const nVal = computeN(current.b2, current.b3, current.b1);
                const calcDensity = computeConsistencyDensity(nVal, current.uscs);
                layers.push({ top: layerTop, bot: layerBot, uscs: current.uscs ? current.uscs.toUpperCase() : 'UNCLASSIFIED', type: 'SOIL', description: buildSoilDescription(current, { ...current, density: calcDensity }) });
            });

            rockSamples.forEach(r => {
                const top = parseFloat(r.whole) + parseFloat(r.dec);
                const bot = top + (parseFloat(r.runLength) || 5.0);
                const rockTypeStr = (r.rockType || 'ROCK').toUpperCase();
                layers.push({ top, bot, uscs: rockTypeStr, type: 'ROCK', rockType: rockTypeStr, description: buildRockDescription(r) });
            });

            const sampleMarkers = soilSamples.map(s => ({ top: parseFloat(s.whole) + parseFloat(s.dec), nVal: computeN(s.b2, s.b3, s.b1) })).filter(m => m.nVal !== undefined && m.nVal !== "" && m.nVal !== null);
            const gwMarkers = (curBoring.gw || []).map(gw => {
                const depthVal = parseFloat(gw.depth);
                if (isNaN(depthVal)) return null;
                const label = getGWProfileLabel(gw);
                return (!label || label === "N/A") ? null : { top: depthVal, label: label };
            }).filter(Boolean);

            renderLiveProfileSVG(layers, sampleMarkers, gwMarkers, totalDepth);
            renderLiveProfileTable(layers);
        }

        function renderLiveProfileSVG(layers, sampleMarkers, gwMarkers, maxDepth) {
            const container = document.getElementById('liveProfileSvgContainer');
            if (!container) return;
            const svgWidth = 350;
            const pxPerFoot = Math.min(26, Math.max(12, 360 / (maxDepth || 30)));
            const svgHeight = Math.max(340, (maxDepth * pxPerFoot) + 50);
            const colX = 75, colWidth = 100, startY = 25;

            let svg = `<svg width="${svgWidth}" height="${svgHeight}" class="font-sans text-xs select-none">
                <defs>
                    <pattern id="hatch-rock" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="8" y2="0" stroke="#0f172a" stroke-width="2.2" /></pattern>
                    <pattern id="hatch-fill" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="6" y2="0" stroke="#ffffff" stroke-width="1.8" /><line x1="0" y1="0" x2="0" y2="6" stroke="#ffffff" stroke-width="1.8" /></pattern>
                    <pattern id="hatch-gravel" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="5" cy="5" r="2.5" fill="none" stroke="#0f172a" stroke-width="1.8" /></pattern>
                    <pattern id="hatch-sand" width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1.5" fill="#713f12" /></pattern>
                    <pattern id="hatch-silt" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><line x1="0" y1="0" x2="0" y2="8" stroke="#1e3a8a" stroke-width="2.0" /></pattern>
                    <pattern id="hatch-silt-dark" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><line x1="0" y1="0" x2="0" y2="8" stroke="#ffffff" stroke-width="2.0" /></pattern>
                    <pattern id="hatch-clay" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" stroke="#7f1d1d" stroke-width="2.0" /></pattern>
                    <pattern id="hatch-clay-high" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#fee2e2" stroke-width="1.8" /><line x2="2" y1="0" x2="2" y2="6" stroke="#fee2e2" stroke-width="1.8" /></pattern>
                    <pattern id="hatch-organic" width="8" height="8" patternUnits="userSpaceOnUse"><line x1="0" y1="0" x2="8" y2="8" stroke="#052e16" stroke-width="2.0" /><line x1="8" y1="0" x2="0" y2="8" stroke="#052e16" stroke-width="2.0" /></pattern>
                    <pattern id="hatch-topsoil" width="10" height="10" patternUnits="userSpaceOnUse"><polygon points="5,1 9,9 1,9" fill="none" stroke="#fffbeb" stroke-width="1.6" /></pattern>
                    <pattern id="hatch-asphalt" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(30)"><line x1="0" y1="0" x2="8" y2="0" stroke="#52525b" stroke-width="1.5" /></pattern>
                    <pattern id="hatch-concrete" width="6" height="6" patternUnits="userSpaceOnUse"><rect x="0" y="0" width="3" height="3" fill="#94a3b8" opacity="0.3"/></pattern>
                    <pattern id="hatch-riprap" width="12" height="12" patternUnits="userSpaceOnUse"><path d="M2,2 L8,2 L10,8 L4,10 Z" fill="none" stroke="#0f172a" stroke-width="1.8"/></pattern>
                    <pattern id="hatch-void" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#dc2626" stroke-width="2.0" /></pattern>
                    <pattern id="hatch-unknown" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="8" y2="0" stroke="#3b0764" stroke-width="1.8" /></pattern>
                </defs>`;

            svg += `<text x="${svgWidth/2}" y="14" text-anchor="middle" font-weight="bold" font-size="12" fill="currentColor">Current Boring Profile</text>`;
            svg += `<line x1="${colX}" y1="${startY}" x2="${colX}" y2="${startY + (maxDepth * pxPerFoot)}" stroke="#64748b" stroke-width="2" />`;

            for (let d = 0; d <= maxDepth; d += 5) {
                const y = startY + (d * pxPerFoot);
                svg += `<line x1="${colX - 4}" y1="${y}" x2="${colX}" y2="${y}" stroke="#64748b" stroke-width="1.5" />`;
                svg += `<text x="${colX - 8}" y="${y + 3}" text-anchor="end" font-weight="600" font-size="9" fill="#64748b">${d}'</text>`;
                svg += `<line x1="${colX}" y1="${y}" x2="${colX + colWidth}" y2="${y}" stroke="#cbd5e1" stroke-dasharray="3,3" opacity="0.5" />`;
            }

            layers.forEach(l => {
                const layerTopY = startY + (l.top * pxPerFoot);
                const layerHeight = Math.max(16, (l.bot - l.top) * pxPerFoot);
                const sym = getGeotechSymbology(l.uscs || l.rockType, l.type);

                svg += `<rect x="${colX}" y="${layerTopY}" width="${colWidth}" height="${layerHeight}" fill="${sym.fill}" stroke="#0f172a" stroke-width="1.2" />`;
                svg += `<rect x="${colX}" y="${layerTopY}" width="${colWidth}" height="${layerHeight}" fill="url(#${sym.hatch})" opacity="0.85" stroke="#0f172a" stroke-width="1.2" />`;

                const midY = layerTopY + (layerHeight / 2);
                const displayText = l.uscs || l.rockType || "";
                if (layerHeight > 16 && displayText) {
                    svg += `<text x="${colX + colWidth/2}" y="${midY + 3.5}" text-anchor="middle" font-weight="800" font-size="10" fill="${sym.textColor}" stroke="${sym.fill}" stroke-width="2.5" paint-order="stroke fill">${displayText}</text>`;
                }
            });

            sampleMarkers.forEach(m => {
                const markerY = startY + (m.top * pxPerFoot);
                const nText = (m.nVal === "Refusal") ? "N=REF" : `N=${m.nVal}`;
                svg += `<rect x="${colX + colWidth + 6}" y="${markerY - 8}" width="42" height="16" rx="3" fill="#1e293b" opacity="0.9" />`;
                svg += `<text x="${colX + colWidth + 27}" y="${markerY + 3.5}" text-anchor="middle" font-weight="700" font-size="9" fill="#f8fafc">${nText}</text>`;
                svg += `<line x1="${colX + colWidth}" y1="${markerY}" x2="${colX + colWidth + 6}" y2="${markerY}" stroke="#64748b" stroke-width="1.2" />`;
            });

            gwMarkers.forEach(gw => {
                const markerY = startY + (gw.top * pxPerFoot);
                const textWidth = Math.max(46, gw.label.length * 6.5 + 10);
                svg += `<polygon points="${colX},${markerY} ${colX-6},${markerY-4} ${colX-6},${markerY+4}" fill="#0284c7" />`;
                svg += `<rect x="${colX - textWidth - 8}" y="${markerY - 8}" width="${textWidth}" height="16" rx="3" fill="#0284c7" opacity="0.95" />`;
                svg += `<text x="${colX - 8 - (textWidth/2)}" y="${markerY + 3.5}" text-anchor="middle" font-weight="700" font-size="8.5" fill="#f8fafc">${gw.label}</text>`;
                svg += `<line x1="${colX - 6}" y1="${markerY}" x2="${colX}" y2="${markerY}" stroke="#0284c7" stroke-width="1.5" />`;
            });

            svg += `</svg>`;
            container.innerHTML = svg;
        }

        function renderLiveProfileTable(layers) {
            const listContainer = document.getElementById('liveProfileLayersList');
            if (!listContainer) return;
            if (layers.length === 0) {
                listContainer.innerHTML = `<span class="text-[11px] text-slate-400 italic">No layers logged yet.</span>`;
                return;
            }
            listContainer.innerHTML = layers.map((l, idx) => `
                <div class="bg-slate-50 dark:bg-slate-800/60 p-2 rounded border border-slate-200 dark:border-slate-700 flex flex-col space-y-0.5">
                    <div class="flex justify-between items-center">
                        <span class="font-bold text-amber-600 dark:text-amber-400">Layer #${idx+1}: ${l.top.toFixed(1)}' - ${l.bot.toFixed(1)}'</span>
                        <span class="bg-slate-200 dark:bg-slate-700 font-bold px-1.5 py-0.5 rounded text-[9px]">${l.uscs || l.rockType}</span>
                    </div>
                    <div class="text-slate-600 dark:text-slate-300 font-medium text-[11px]">${l.description}</div>
                </div>
            `).join('');
        }

        // --- Multi-Boring Profiles Tool ---
        let profileSelectedBoringIds = [];

        function openProjectBoringProfilesModal() {
            const modal = document.getElementById('projectBoringProfilesModal');
            if (!modal) return;
            const sortedBorings = [...borings].sort((a, b) => compareBoringIds(a.id, b.id));
            if (profileSelectedBoringIds.length === 0 && sortedBorings.length > 0) {
                profileSelectedBoringIds = sortedBorings.map(b => b.id);
            }
            renderProfilesCheckboxes();
            renderProfilesCanvas();
            modal.classList.remove('hidden');
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }

        function closeProjectBoringProfilesModal() {
            document.getElementById('projectBoringProfilesModal').classList.add('hidden');
        }

        function profilesSelectAll(selectAll) {
            const sortedBorings = [...borings].sort((a, b) => compareBoringIds(a.id, b.id));
            profileSelectedBoringIds = selectAll ? sortedBorings.map(b => b.id) : [];
            renderProfilesCheckboxes();
            renderProfilesCanvas();
        }

        function onProfileCheckboxChange(boringId, checked) {
            if (checked) {
                if (!profileSelectedBoringIds.includes(boringId)) profileSelectedBoringIds.push(boringId);
            } else {
                profileSelectedBoringIds = profileSelectedBoringIds.filter(id => id !== boringId);
            }
            renderProfilesCanvas();
        }

        function renderProfilesCheckboxes() {
            const container = document.getElementById('profilesBoringCheckboxes');
            if (!container) return;
            const sortedBorings = [...borings].sort((a, b) => compareBoringIds(a.id, b.id));
            container.innerHTML = sortedBorings.map(b => {
                const isChecked = profileSelectedBoringIds.includes(b.id);
                return `
                    <label class="flex items-center space-x-2.5 p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer transition">
                        <input type="checkbox" ${isChecked ? 'checked' : ''} onchange="onProfileCheckboxChange('${b.id}', this.checked)" class="w-4 h-4 accent-amber-500 rounded">
                        <span class="font-bold text-xs text-slate-700 dark:text-slate-200">Boring ${b.id}</span>
                    </label>
                `;
            }).join('');
        }

        function renderProfilesCanvas() {
            const container = document.getElementById('profilesCanvasContainer');
            if (!container) return;
            const selectedBorings = borings.filter(b => profileSelectedBoringIds.includes(b.id));

            if (selectedBorings.length === 0) {
                container.innerHTML = `
                    <div class="flex flex-col items-center justify-center w-full h-96 text-center space-y-2">
                        <i data-lucide="layers" class="w-10 h-10 text-slate-400"></i>
                        <p class="font-bold text-sm text-slate-600 dark:text-slate-400">No borings selected.</p>
                        <p class="text-xs text-slate-400">Check one or more borings on the left panel to compare profiles side-by-side.</p>
                    </div>
                `;
                if (typeof lucide !== 'undefined') lucide.createIcons();
                return;
            }

            let maxProjectDepth = 30;
            selectedBorings.forEach(b => {
                const d = parseFloat(b.totalDepth) || 30;
                if (d > maxProjectDepth) maxProjectDepth = d;
            });

            container.innerHTML = selectedBorings.map(b => {
                const surfaceConditions = b.surfaceConditions || [];
                const soilSamples = b.samples || [];
                const rockSamples = b.rockSamples || [];
                const totalDepth = parseFloat(b.totalDepth) || 30;

                const layers = [];
                let currentSurfaceDepth = 0.0;
                surfaceConditions.forEach(sc => {
                    const thickInches = parseFloat(sc.thickness) || 0;
                    const thickFeet = thickInches / 12.0;
                    const layerTop = currentSurfaceDepth;
                    const layerBot = currentSurfaceDepth + thickFeet;
                    currentSurfaceDepth = layerBot;
                    layers.push({ top: layerTop, bot: layerBot, uscs: (sc.type || 'SURFACE').toUpperCase(), type: 'SURFACE' });
                });

                soilSamples.forEach((current, i) => {
                    let layerTop = (i === 0) ? ((surfaceConditions.length > 0) ? currentSurfaceDepth : 0.0) : (parseFloat(current.whole) + parseFloat(current.dec));
                    let layerBot;
                    if (i < soilSamples.length - 1) {
                        layerBot = parseFloat(soilSamples[i + 1].whole) + parseFloat(soilSamples[i + 1].dec);
                    } else if (rockSamples.length > 0) {
                        layerBot = parseFloat(rockSamples[0].whole) + parseFloat(rockSamples[0].dec);
                    } else {
                        layerBot = Math.max(totalDepth, layerTop + 3.0);
                    }
                    if (layerBot < layerTop) layerBot = layerTop;
                    layers.push({ top: layerTop, bot: layerBot, uscs: current.uscs ? current.uscs.toUpperCase() : 'UNCLASSIFIED', type: 'SOIL' });
                });

                rockSamples.forEach(r => {
                    const top = parseFloat(r.whole) + parseFloat(r.dec);
                    const bot = top + (parseFloat(r.runLength) || 5.0);
                    const rockTypeStr = (r.rockType || 'ROCK').toUpperCase();
                    layers.push({ top, bot, uscs: rockTypeStr, type: 'ROCK', rockType: rockTypeStr });
                });

                const sampleMarkers = soilSamples.map(s => ({ top: parseFloat(s.whole) + parseFloat(s.dec), nVal: computeN(s.b2, s.b3, s.b1) })).filter(m => m.nVal !== undefined && m.nVal !== "" && m.nVal !== null);
                const gwMarkers = (b.gw || []).map(gw => {
                    const depthVal = parseFloat(gw.depth);
                    if (isNaN(depthVal)) return null;
                    const label = getGWProfileLabel(gw);
                    return (!label || label === "N/A") ? null : { top: depthVal, label: label };
                }).filter(Boolean);

                const svgWidth = 320;
                const pxPerFoot = Math.min(22, Math.max(12, 450 / (maxProjectDepth || 30)));
                const svgHeight = Math.max(400, (maxProjectDepth * pxPerFoot) + 50);
                const colX = 75, colWidth = 100, startY = 25;

                let svg = `<svg width="${svgWidth}" height="${svgHeight}" class="font-sans text-xs select-none">`;
                svg += `<line x1="${colX}" y1="${startY}" x2="${colX}" y2="${startY + (maxProjectDepth * pxPerFoot)}" stroke="#64748b" stroke-width="2" />`;

                for (let d = 0; d <= maxProjectDepth; d += 5) {
                    const y = startY + (d * pxPerFoot);
                    svg += `<line x1="${colX - 4}" y1="${y}" x2="${colX}" y2="${y}" stroke="#64748b" stroke-width="1.5" />`;
                    svg += `<text x="${colX - 8}" y="${y + 3}" text-anchor="end" font-weight="600" font-size="9" fill="#64748b">${d}'</text>`;
                    svg += `<line x1="${colX}" y1="${y}" x2="${colX + colWidth}" y2="${y}" stroke="#cbd5e1" stroke-dasharray="3,3" opacity="0.5" />`;
                }

                layers.forEach(l => {
                    const layerTopY = startY + (l.top * pxPerFoot);
                    const layerHeight = Math.max(16, (l.bot - l.top) * pxPerFoot);
                    const sym = getGeotechSymbology(l.uscs || l.rockType, l.type);

                    svg += `<rect x="${colX}" y="${layerTopY}" width="${colWidth}" height="${layerHeight}" fill="${sym.fill}" stroke="#0f172a" stroke-width="1.2" />`;
                    svg += `<rect x="${colX}" y="${layerTopY}" width="${colWidth}" height="${layerHeight}" fill="url(#${sym.hatch})" opacity="0.85" stroke="#0f172a" stroke-width="1.2" />`;

                    const midY = layerTopY + (layerHeight / 2);
                    const displayText = l.uscs || l.rockType || "";
                    if (layerHeight > 16 && displayText) {
                        svg += `<text x="${colX + colWidth/2}" y="${midY + 3.5}" text-anchor="middle" font-weight="800" font-size="10" fill="${sym.textColor}" stroke="${sym.fill}" stroke-width="2.5" paint-order="stroke fill">${displayText}</text>`;
                    }
                });

                sampleMarkers.forEach(m => {
                    const markerY = startY + (m.top * pxPerFoot);
                    const nText = (m.nVal === "Refusal") ? "N=REF" : `N=${m.nVal}`;
                    svg += `<rect x="${colX + colWidth + 6}" y="${markerY - 8}" width="42" height="16" rx="3" fill="#1e293b" opacity="0.9" />`;
                    svg += `<text x="${colX + colWidth + 27}" y="${markerY + 3.5}" text-anchor="middle" font-weight="700" font-size="9" fill="#f8fafc">${nText}</text>`;
                    svg += `<line x1="${colX + colWidth}" y1="${markerY}" x2="${colX + colWidth + 6}" y2="${markerY}" stroke="#64748b" stroke-width="1.2" />`;
                });

                gwMarkers.forEach(gw => {
                    const markerY = startY + (gw.top * pxPerFoot);
                    const textWidth = Math.max(46, gw.label.length * 6.5 + 10);
                    svg += `<polygon points="${colX},${markerY} ${colX-6},${markerY-4} ${colX-6},${markerY+4}" fill="#0284c7" />`;
                    svg += `<rect x="${colX - textWidth - 8}" y="${markerY - 8}" width="${textWidth}" height="16" rx="3" fill="#0284c7" opacity="0.95" />`;
                    svg += `<text x="${colX - 8 - (textWidth/2)}" y="${markerY + 3.5}" text-anchor="middle" font-weight="700" font-size="8.5" fill="#f8fafc">${gw.label}</text>`;
                    svg += `<line x1="${colX - 6}" y1="${markerY}" x2="${colX}" y2="${markerY}" stroke="#0284c7" stroke-width="1.5" />`;
                });

                svg += `</svg>`;

                return `
                    <div class="bg-white dark:bg-slate-900 rounded-xl p-4 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col space-y-3 flex-shrink-0">
                        <div class="flex justify-between items-center border-b border-slate-100 dark:border-slate-800 pb-2">
                            <div>
                                <h4 class="font-extrabold text-amber-600 dark:text-amber-400 text-sm">Boring ${b.id}</h4>
                                <p class="text-[11px] text-slate-400">Total Depth: ${b.totalDepth || '0.0'} ft | Rig: ${b.rig || 'N/A'}</p>
                            </div>
                        </div>
                        <div class="overflow-y-auto flex justify-center bg-slate-50 dark:bg-slate-950/50 p-2 rounded-lg border border-slate-100 dark:border-slate-800">
                            ${svg}
                        </div>
                    </div>
                `;
            }).join('');
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }

        // --- Summary Figures & Percentage Histograms ---
        let uscsChartInstance = null;
        let soilRockChartInstance = null;
        let recoveryHistInstance = null;
        let rqdHistInstance = null;

        function openSummaryFiguresModal() {
            const modal = document.getElementById('summaryFiguresModal');
            if (!modal) return;
            modal.classList.remove('hidden');
            setTimeout(() => computeAndRenderSummaryFigures(), 100);
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }

        function closeSummaryFiguresModal() {
            document.getElementById('summaryFiguresModal').classList.add('hidden');
        }

        function computeAndRenderSummaryFigures() {
            let drillingTableHtml = '';
            let totalSoilFootageAll = 0;
            let totalRockFootageAll = 0;
            let totalDrilledFootageAll = 0;

            const uscsFootageMap = {};
            let recoveryPercentages = [];
            let rqdPercentages = [];

            let minWaterDepth = 9999;
            let maxWaterDepth = -1;
            let highestWaterElev = -999999;
            let lowestWaterElev = 999999;
            let boringsWithWaterCount = 0;
            let boringsWithoutWaterCount = 0;
            let hasWaterElevationData = false;

            borings.forEach(b => {
                const totalDepth = parseFloat(b.totalDepth) || 0.0;
                let depthToRock = "N/A";
                let rockFootage = 0;
                let soilFootage = 0;

                if (b.rockSamples && b.rockSamples.length > 0) {
                    const sortedRock = [...b.rockSamples].sort((r1, r2) => (parseFloat(r1.whole) + parseFloat(r1.dec)) - (parseFloat(r2.whole) + parseFloat(r2.dec)));
                    const firstRock = sortedRock[0];
                    const depthToRockVal = parseFloat(firstRock.whole) + parseFloat(firstRock.dec);
                    depthToRock = depthToRockVal.toFixed(1) + "'";

                    b.rockSamples.forEach(r => {
                        const runLen = parseFloat(r.runLength) || 0;
                        rockFootage += runLen;
                        const recVal = parseFloat(r.recovery);
                        if (!isNaN(recVal) && runLen > 0) {
                            recoveryPercentages.push(Math.min(100, Math.max(0, (recVal / runLen) * 100)));
                        }
                        const rqdVal = parseFloat(r.rqd);
                        if (!isNaN(rqdVal) && runLen > 0) {
                            rqdPercentages.push(Math.min(100, Math.max(0, (rqdVal / runLen) * 100)));
                        }
                    });
                    soilFootage = depthToRockVal;
                } else {
                    soilFootage = totalDepth;
                    rockFootage = 0;
                }

                totalSoilFootageAll += soilFootage;
                totalRockFootageAll += rockFootage;
                totalDrilledFootageAll += totalDepth;

                drillingTableHtml += `
                    <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                        <td class="py-2.5 px-3 font-bold text-amber-600 dark:text-amber-400">${b.id || 'N/A'}</td>
                        <td class="py-2.5 px-3 text-right">${depthToRock}</td>
                        <td class="py-2.5 px-3 text-right">${soilFootage.toFixed(1)}'</td>
                        <td class="py-2.5 px-3 text-right">${rockFootage.toFixed(1)}'</td>
                        <td class="py-2.5 px-3 text-right font-extrabold">${totalDepth.toFixed(1)}'</td>
                    </tr>
                `;

                const samples = b.samples || [];
                if (samples.length > 0) {
                    const footagePerSample = soilFootage / samples.length;
                    samples.forEach(s => {
                        const uscsCode = (s.uscs || 'UNCLASSIFIED').toUpperCase().trim();
                        uscsFootageMap[uscsCode] = (uscsFootageMap[uscsCode] || 0) + footagePerSample;
                    });
                } else if (soilFootage > 0) {
                    uscsFootageMap['UNCLASSIFIED'] = (uscsFootageMap['UNCLASSIFIED'] || 0) + soilFootage;
                }

                let hasWaterInBoring = false;
                const groundElev = parseFloat(b.gpsElevation) || null;
                if (b.gw && b.gw.length > 0) {
                    b.gw.forEach(gw => {
                        const d = parseFloat(gw.depth);
                        if (!isNaN(d) && gw.time && gw.time !== 'N/A' && gw.time !== 'N/E') {
                            hasWaterInBoring = true;
                            if (d < minWaterDepth) minWaterDepth = d;
                            if (d > maxWaterDepth) maxWaterDepth = d;
                            if (groundElev !== null && !isNaN(groundElev)) {
                                const waterElev = groundElev - d;
                                hasWaterElevationData = true;
                                if (waterElev > highestWaterElev) highestWaterElev = waterElev;
                                if (waterElev < lowestWaterElev) lowestWaterElev = waterElev;
                            }
                        }
                    });
                }
                if (hasWaterInBoring) boringsWithWaterCount++;
                else boringsWithoutWaterCount++;
            });

            document.getElementById('summaryDrillingTbody').innerHTML = drillingTableHtml + `
                <tr class="bg-slate-100 dark:bg-slate-800 font-extrabold">
                    <td class="py-2.5 px-3">TOTAL / PROJECT</td>
                    <td class="py-2.5 px-3 text-right">--</td>
                    <td class="py-2.5 px-3 text-right">${totalSoilFootageAll.toFixed(1)}'</td>
                    <td class="py-2.5 px-3 text-right">${totalRockFootageAll.toFixed(1)}'</td>
                    <td class="py-2.5 px-3 text-right text-amber-600 dark:text-amber-400">${totalDrilledFootageAll.toFixed(1)}'</td>
                </tr>
            `;

            document.getElementById('gwStatMinDepth').textContent = (minWaterDepth !== 9999) ? `${minWaterDepth.toFixed(1)} ft` : "N/E";
            document.getElementById('gwStatMaxDepth').textContent = (maxWaterDepth !== -1) ? `${maxWaterDepth.toFixed(1)} ft` : "N/E";
            document.getElementById('gwStatWithWater').textContent = boringsWithWaterCount;
            document.getElementById('gwStatWithoutWater').textContent = boringsWithoutWaterCount;
            document.getElementById('gwStatHighElev').textContent = hasWaterElevationData ? `${highestWaterElev.toFixed(1)} ft` : "N/A";
            document.getElementById('gwStatLowElev').textContent = hasWaterElevationData ? `${lowestWaterElev.toFixed(1)} ft` : "N/A";

            renderUSCSPieChart(uscsFootageMap);
            renderSoilRockPieChart(totalSoilFootageAll, totalRockFootageAll);
            renderPercentageHistogram('recoveryHistogram', recoveryPercentages, 'Recovery Quality (%)', '#10b981');
            renderPercentageHistogram('rqdHistogram', rqdPercentages, 'RQD Quality (%)', '#3b82f6');
        }

        function renderUSCSPieChart(uscsMap) {
            const ctx = document.getElementById('uscsPieChart').getContext('2d');
            if (uscsChartInstance) uscsChartInstance.destroy();
            const labels = Object.keys(uscsMap);
            const data = Object.values(uscsMap);
            if (labels.length === 0) { labels.push('No Soil Data'); data.push(1); }

            uscsChartInstance = new Chart(ctx, {
                type: 'pie',
                data: {
                    labels: labels,
                    datasets: [{ data: data, backgroundColor: ['#f59e0b', '#3b82f6', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#64748b', '#14b8a6', '#f97316', '#6366f1'] }]
                },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 10 } } } } }
            });
        }

        function renderSoilRockPieChart(soilFt, rockFt) {
            const ctx = document.getElementById('soilRockPieChart').getContext('2d');
            if (soilRockChartInstance) soilRockChartInstance.destroy();
            soilRockChartInstance = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: ['Soil Drilling', 'Rock Coring'],
                    datasets: [{ data: [soilFt, rockFt], backgroundColor: ['#f59e0b', '#475569'] }]
                },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 10 } } } } }
            });
        }

        function renderPercentageHistogram(canvasId, pctValues, labelName, barColor) {
            const ctx = document.getElementById(canvasId).getContext('2d');
            if (canvasId === 'recoveryHistogram' && recoveryHistInstance) recoveryHistInstance.destroy();
            if (canvasId === 'rqdHistogram' && rqdHistInstance) rqdHistInstance.destroy();

            const bins = { '0-25%': 0, '25-50%': 0, '50-75%': 0, '75-90%': 0, '90-100%': 0 };

            pctValues.forEach(val => {
                if (val <= 25) bins['0-25%']++;
                else if (val <= 50) bins['25-50%']++;
                else if (val <= 75) bins['50-75%']++;
                else if (val <= 90) bins['75-90%']++;
                else bins['90-100%']++;
            });

            const chartObj = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: Object.keys(bins),
                    datasets: [{ label: labelName, data: Object.values(bins), backgroundColor: barColor, borderRadius: 6 }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } },
                    plugins: { legend: { display: false } }
                }
            });

            if (canvasId === 'recoveryHistogram') recoveryHistInstance = chartObj;
            if (canvasId === 'rqdHistogram') rqdHistInstance = chartObj;
        }

        // --- Export & File Management ---
        function exportJSON() {
            const payload = {
                application: "StrataScribe",
                version: "v1.6.13",
                exportTimestamp: new Date().toISOString(),
                projectMeta: projectMeta,
                borings: borings
            };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const dlAnchor = document.createElement('a');
            dlAnchor.href = url;
            dlAnchor.download = buildExportFilename("json");
            document.body.appendChild(dlAnchor);
            dlAnchor.click();
            dlAnchor.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);

            markSavedNow();
            showToast("Project saved (JSON backup exported).");
        }

        async function shareProjectJSON() {
            const payload = {
                application: "StrataScribe",
                version: "v1.6.16",
                exportTimestamp: new Date().toISOString(),
                projectMeta: projectMeta,
                borings: borings
            };
            // Use .txt extension and text/plain MIME type so Android's share sheet always accepts it
            const filename = buildExportFilename("txt");
            const jsonText = JSON.stringify(payload, null, 2);
            
            // 1. Try native mobile share sheet if supported
            if (navigator.share && navigator.canShare) {
                try {
                    const file = new File([jsonText], filename, { type: 'text/plain' });
                    if (navigator.canShare({ files: [file] })) {
                        await navigator.share({
                            files: [file],
                            title: 'StrataScribe Project',
                            text: `Project Backup: ${projectMeta.name || 'Unnamed'}`
                        });
                        showToast("Project shared successfully.");
                        return;
                    }
                } catch (err) {
                    if (err && err.name === 'AbortError') return; // User cancelled share sheet
                    console.warn("Native share failed, falling back to download:", err);
                }
            }

            // 2. Fallback to standard download if native share isn't available
            exportJSON();
        }

        function triggerJSONUpload() {
            document.getElementById('jsonFileInput').click();
        }

        function importJSON(event) {
            const file = event.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = function(e) {
                try {
                    const parsed = JSON.parse(e.target.result);
                    if (parsed.borings && Array.isArray(parsed.borings)) {
                        borings = parsed.borings;
                        if (parsed.projectMeta) projectMeta = parsed.projectMeta;
                        activeBoringIndex = 0;
                        updateBoringSelector();
                        syncHeaderUI();
                        renderTables();
                        markSavedNow();
                        saveLocal();
                        showToast("Project successfully imported!");
                    } else {
                        alert("Invalid project JSON structure.");
                    }
                } catch (err) {
                    alert("Failed to parse JSON file: " + err.message);
                }
                event.target.value = "";
            };
            reader.readAsText(file);
        }

        function exportCSV() {
            let csvRows = [];
            csvRows.push(["StrataScribe v1.6.13 Structured Project CSV Export"]);
            csvRows.push([`Client: "${projectMeta.client || ''}"`, `Project Name: "${projectMeta.name || ''}"`, `Project Number: "${projectMeta.number || ''}"`]);
            csvRows.push([]);

            borings.forEach((b) => {
                csvRows.push([`=== BORING: ${b.id || 'N/A'} ===`]);
                csvRows.push([`Rig: "${b.rig || ''}"`, `Driller: "${b.driller || ''}"`, `Field Logger: "${b.logger || ''}"`, `Total Depth: "${b.totalDepth || ''}"`, `Offset: "${b.offset || ''}"`, `Direction: "${b.direction || ''}"`, `Termination Reason: "${b.terminationReason || ''}"`, `Refusal Type: "${b.refusalType || ''}"`, `Refusal Depth: "${b.refusalDepth || ''}"`]);
                csvRows.push([`GPS Lat: "${b.gpsLat || ''}"`, `GPS Lon: "${b.gpsLon || ''}"`, `GPS Accuracy: "${b.gpsAccuracy || ''}"`]);
                csvRows.push([]);

                csvRows.push(["-- SURFACE CONDITIONS --"]);
                csvRows.push(["Thickness (in)", "Type", "Remarks"]);
                (b.surfaceConditions || []).forEach(sc => {
                    csvRows.push([sc.thickness || "", `"${sc.type || ''}"`, `"${sc.remarks || ''}"`]);
                });
                csvRows.push([]);

                csvRows.push(["-- SOIL SAMPLES (Structured) --"]);
                csvRows.push([
                    "Depth (ft)", "Sample Type", "Length (in)", "Blow 1", "Blow 2", "Blow 3", "N-Value", "Recovery (in)",
                    "USCS", "Gradation", "Major Modifier", "Minor Modifier", "Moisture", "Density / Consistency", "Origin", "Shade", "Colors", "Mottling",
                    "Auto Description", "Remarks"
                ]);
                (b.samples || []).forEach(s => {
                    const topDepth = (parseFloat(s.whole) + parseFloat(s.dec)).toFixed(1);
                    const nVal = computeN(s.b2, s.b3, s.b1);
                    const calcDensity = computeConsistencyDensity(nVal, s.uscs);
                    const autoDesc = buildSoilDescription(s, { ...s, density: calcDensity });
                    csvRows.push([
                        topDepth, s.type || "", s.length || "", s.b1 || "", s.b2 || "", s.b3 || "", nVal, s.rec || "",
                        `"${s.uscs || ''}"`, `"${s.gradation || ''}"`, `"${s.major || ''}"`, `"${s.minor || ''}"`, `"${s.moisture || ''}"`, `"${calcDensity || ''}"`, `"${s.origin || ''}"`, `"${s.shade || ''}"`, `"${formatColorsString(s.colors)}"`, `"${s.mottling || ''}"`,
                        `"${autoDesc}"`, `"${s.remarks || ''}"`
                    ]);
                });
                csvRows.push([]);

                csvRows.push(["-- ROCK CORE RUNS (Structured) --"]);
                csvRows.push([
                    "Top Depth (ft)", "Run Length (ft)", "Bottom Depth (ft)",
                    "Rock Type", "Weathering", "Grain Size", "Grain Shape", "Strength",
                    "Bedding / Foliation", "Joint Type", "Joint Spacing", "Joint Persistence",
                    "Joint Surface Roughness", "Joint Geometry", "Joint Aperture", "Joint Filling",
                    "Groundwater Condition", "Natural Fractures / ft", "Descriptors",
                    "Recovery (ft)", "Recovery (in)", "RQD (ft)", "RQD (in)",
                    "Auto Description", "Remarks"
                ]);
                (b.rockSamples || []).forEach(r => {
                    const topDepth = (parseFloat(r.whole) + parseFloat(r.dec)).toFixed(1);
                    const runLen = parseFloat(r.runLength) || 0;
                    const botDepth = (parseFloat(topDepth) + runLen).toFixed(1);
                    const autoDesc = buildRockDescription(r);
                    const descList = r.descriptors ? r.descriptors.join(', ') : "";
                    const recInchesStr = formatInchesDisplayString(r.recWhole, r.recFrac);
                    const rqdInchesStr = formatInchesDisplayString(r.rqdWhole, r.rqdFrac);
                    const weatheringCsv = formatMultiRockField(r.weathering);
                    const grainSizeCsv = formatMultiRockField(r.grainSize);
                    const grainShapeCsv = formatMultiRockField(r.grainShape);
                    const strengthCsv = formatMultiRockField(r.strength);
                    const beddingCsv = formatMultiRockField(r.bedding);
                    csvRows.push([
                        topDepth, r.runLength || "", botDepth,
                        `"${r.rockType || ''}"`, `"${weatheringCsv}"`, `"${grainSizeCsv}"`, `"${grainShapeCsv}"`, `"${strengthCsv}"`,
                        `"${beddingCsv}"`, `"${r.jointType || ''}"`, `"${r.jointSpacing || ''}"`, `"${r.jointPersistence || ''}"`,
                        `"${r.jointRoughness || ''}"`, `"${r.jointGeometry || ''}"`, `"${r.jointAperture || ''}"`, `"${r.jointFilling || ''}"`,
                        `"${r.gwCondition || ''}"`, r.natFractures || "0", `"${descList}"`,
                        r.recovery || "", `"${recInchesStr}"`, r.rqd || "", `"${rqdInchesStr}"`,
                        `"${autoDesc}"`, `"${r.remarks || ''}"`
                    ]);
                });
                csvRows.push([]); csvRows.push([]);
            });

            const csvContent = "data:text/csv;charset=utf-8," + csvRows.map(e => e.join(",")).join("\n");
            const encodedUri = encodeURI(csvContent);
            const dlAnchor = document.createElement('a');
            dlAnchor.setAttribute("href", encodedUri);
            dlAnchor.setAttribute("download", buildExportFilename("csv"));
            document.body.appendChild(dlAnchor);
            dlAnchor.click();
            dlAnchor.remove();
            showToast("Structured CSV export generated successfully.");
        }

        // --- Lifecycle & Init ---
        window.addEventListener('DOMContentLoaded', async () => {
            await loadLocal();
            updateBoringSelector();
            syncHeaderUI();
            renderTables();
            if (typeof lucide !== 'undefined') lucide.createIcons();
            isInitialized = true;
        });

        // Mobile lifecycle event listeners to guarantee data is saved when closing/switching apps
        window.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                saveLocalSync();
            }
        });
        window.addEventListener('pagehide', () => {
            saveLocalSync();
        });
        window.addEventListener('beforeunload', (e) => {
            saveLocalSync();
            if (!isSaved) {
                e.preventDefault();
                e.returnValue = "";
            }
        });