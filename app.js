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
        const DB_VERSION = 3;
        const LOCAL_STORAGE_KEY = 'strata_scribe_autosave_v1_6_10';

        function openDB() {
            return new Promise((resolve, reject) => {
                const request = indexedDB.open(DB_NAME, DB_VERSION);
                request.onupgradeneeded = (event) => {
                    const db = event.target.result;
                    if (!db.objectStoreNames.contains(STORE_NAME)) {
                        db.createObjectStore(STORE_NAME);
                    }
                };
                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    const db = request.result;
                    db.onversionchange = () => db.close();
                    resolve(db);
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
                        migrateLegacyGroundwaterObservationTypes();
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
                    migrateLegacyGroundwaterObservationTypes();
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
                version: "v1.7.0",
                exportTimestamp: new Date().toISOString(),
                projectMeta: projectMeta,
                borings: borings
            };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const dlAnchor = document.createElement('a');
            dlAnchor.href = url;
            dlAnchor.download = buildExportFilename("txt");
            document.body.appendChild(dlAnchor);
            dlAnchor.click();
            dlAnchor.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);

            isSaved = true;
            unsavedSinceTime = null;
            lastSaveOrBackupTime = Date.now();
            updateSaveStatusUI();
            showToast("Automatic backup exported successfully.");
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
            "Topsoil", "Asphalt", "Concrete", "Mineral Aggregate Base", "Crushed Stone Base", "Base Stone", "Shot Rock", "Gravel Surface", "Chip Seal", "Asphalt Millings", "Mulch", "Landscaping Rock", "Riprap", "Structural Fill", "Existing Fill", "Brick", "Pavement", "Sidewalk", "Crushed Concrete", "Flowable Fill", "Peat", "Organics", "Debris", "Cinders", "Slag", "Coal Ash", "Other (Custom)"
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

        function normalizeGroundwaterObservationType(value) {
            const type = String(value || '').trim();
            const types = {
                'atd': 'ATD',
                'ad': 'AD',
                'next day': 'Next Day',
                'cave in': 'Cave In',
                'after coring': 'After Coring',
                'after mud rotary': 'After Rotary Wash',
                'after rotary wash': 'After Rotary Wash',
                'n/e': 'N/E',
                'n/a': 'N/A',
                'other': 'Other'
            };
            return types[type.toLowerCase()] || type;
        }

        function migrateLegacyGroundwaterObservationTypes() {
            borings.forEach(boring => {
                (boring.gw || []).forEach(observation => {
                    if (observation && String(observation.time || '').trim().toLowerCase() === 'after mud rotary') {
                        observation.time = 'After Rotary Wash';
                    }
                });
            });
        }

        function getGWProfileLabel(gw) {
            if (!gw || !gw.time) return "";
            const observationType = normalizeGroundwaterObservationType(gw.time);
            if (observationType === 'Other') return gw.customTime ? gw.customTime.toUpperCase() : 'OTHER';
            const labels = {
                "ATD": "GW: ATD",
                "AD": "GW: AD",
                "Next Day": "GW: ND",
                "Cave In": "GW: CI",
                "After Coring": "GW: AC",
                "After Rotary Wash": "GW: ARW",
                "N/E": "GW: NE",
                "N/A": "GW: NA",
                "Other": "GW: NOTE"
            };
            return labels[observationType] || "GW";
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

        function boringIdExists(id, excludedIndex = -1) {
            const normalizedId = String(id || "").trim().toLowerCase();
            if (!normalizedId) return false;
            return borings.some((boring, index) =>
                index !== excludedIndex && String(boring.id || "").trim().toLowerCase() === normalizedId
            );
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
            let nextNum = existingNums.length > 0 ? Math.max(...existingNums) + 1 : borings.length + 1;
            let newBoringId = formatBoringId(prefix || 'B', nextNum);
            while (boringIdExists(newBoringId)) {
                newBoringId = formatBoringId(prefix || 'B', ++nextNum);
            }
            
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
            if (field === 'id') {
                val = String(val || "").trim();
                if (boringIdExists(val, activeBoringIndex)) {
                    alert("Boring ID already exists.\n\nPlease enter a unique ID.");
                    const idInput = document.getElementById('boringId');
                    if (idInput) idInput.value = borings[activeBoringIndex].id || "";
                    return;
                }
            }
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
                document.getElementById(`gwTime${i+1}`).value = normalizeGroundwaterObservationType(gw.time || "N/A");
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

        function buildSoilRecoveryOptions(sample) {
            const selectedRecovery = String(sample.rec == null ? "" : sample.rec);
            const parsedRecovery = Number.parseFloat(selectedRecovery);
            const options = Array.from({ length: 41 }, (_, value) => String(value));
            if (Number.isFinite(parsedRecovery) && !options.includes(selectedRecovery)) options.push(selectedRecovery);
            options.sort((a, b) => Number(a) - Number(b));
            return `<option value=""></option>${options.map(value =>
                `<option value="${value}" ${selectedRecovery === value ? 'selected' : ''}>${value}"</option>`
            ).join('')}`;
        }

        function syncBulkSampleRecovery(sample) {
            const sampleLength = Number.parseFloat(String(sample.length == null ? "" : sample.length));
            sample.rec = Number.isFinite(sampleLength) && sampleLength >= 0 ? String(sampleLength) : "";
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
                            id="soilRecovery_${idx}"
                            onchange="updateSoilRow(${idx}, 'rec', this.value)"
                            class="table-select text-center">
                            <option value=""></option>
                            ${buildSoilRecoveryOptions(s)}
                        </select>
                    </td>
                    <td class="py-2.5 px-3">
                        <button onclick="openSoilPropsModal(${idx})" class="w-full table-input text-left whitespace-normal break-words bg-amber-500/10 dark:bg-amber-500/20 text-amber-800 dark:text-amber-300 font-bold border border-amber-500/30 hover:bg-amber-500/25 transition flex items-center justify-between px-3 py-2 min-h-[36px]">
                            <span class="flex-1 pr-2">${soilSummary}</span>
                            <i data-lucide="edit-3" class="w-3.5 h-3.5 flex-shrink-0"></i>
                        </button>
                    </td>
                    <td class="py-2.5 px-3">
                        <button id="remarksButton_soil_${idx}" type="button" onclick="openRemarksEditor('soil', ${idx}, this)" class="w-full table-input text-left text-xs font-semibold flex items-center space-x-2">
                            <i data-lucide="message-square-text" class="w-3.5 h-3.5 flex-shrink-0"></i>
                            <span data-remarks-label>${String(s.remarks || '').trim() ? 'Has Notes' : 'Add Remarks'}</span>
                        </button>
                    </td>
                    <td class="py-2.5 px-3 text-center"><button onclick="deleteSoilRow(${idx})" class="text-rose-500 hover:text-rose-700 p-1"><i data-lucide="trash-2" class="w-4 h-4"></i></button></td>
                `;
                tbody.appendChild(tr);
            });
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }

        function onSampleTypeChange(idx, val) {
            const sample = borings[activeBoringIndex].samples[idx];
            const previousType = sample.type;
            sample.type = val;
            if (sampleLengthDefaults[val] !== undefined) {
                sample.length = sampleLengthDefaults[val];
            }
            if (val === 'BULK') syncBulkSampleRecovery(sample);
            else if (previousType === 'BULK') sample.rec = "";
            markUnsaved();
            renderTables();
        }

        function updateSoilRow(idx, field, val) {
            const sample = borings[activeBoringIndex].samples[idx];
            sample[field] = val;
            if (field === 'length' && sample.type === 'BULK') {
                syncBulkSampleRecovery(sample);
                const recoverySelect = document.getElementById(`soilRecovery_${idx}`);
                if (recoverySelect) recoverySelect.innerHTML = buildSoilRecoveryOptions(sample);
            }
            markUnsaved();
            saveLocal();
            if (['b1', 'b2', 'b3'].includes(field)) {
                renderTables();
            }
        }

        function getDefaultSoilSampleTopDepth(samples) {
            if (!samples.length) return 1;
            const deepestBottom = samples.reduce((deepest, sample) => {
                const top = getRemarksDepth(sample.whole, sample.dec);
                if (top === null) return deepest;
                const lengthInches = Number.parseFloat(String(sample.length == null ? "" : sample.length));
                const bottom = top + (Number.isFinite(lengthInches) ? lengthInches / 12 : 0);
                return Math.max(deepest, bottom);
            }, Number.NEGATIVE_INFINITY);
            if (!Number.isFinite(deepestBottom)) return 1;

            const standardDepths = [1, 3.5, 6, 8.5, 13.5];
            while (standardDepths[standardDepths.length - 1] <= deepestBottom) {
                standardDepths.push(standardDepths[standardDepths.length - 1] + 5);
            }
            return standardDepths.find(depth => depth > deepestBottom);
        }

        function addSoilRow() {
            const curSamples = borings[activeBoringIndex].samples;
            const last = curSamples[curSamples.length - 1];
            const nextTop = getDefaultSoilSampleTopDepth(curSamples);
            const nextWhole = Math.floor(nextTop);
            const nextDecimal = (nextTop - nextWhole).toFixed(1);
            const defaultType = last ? last.type : "SS";
            const defaultLength = sampleLengthDefaults[defaultType] || "18\"";
            
            curSamples.push({
                whole: nextWhole, dec: nextDecimal, type: defaultType, length: defaultLength,
                b1: "", b2: "", b3: "", rec: defaultType === "BULK" ? String(Number.parseFloat(defaultLength)) : "",
                uscs: last ? last.uscs : "", gradation: last ? last.gradation : "", major: last ? last.major : "", minor: last ? last.minor : "", 
                moisture: last ? last.moisture : "", shade: "", colors: last && last.colors ? [...last.colors] : [], 
                origin: last ? last.origin : "", mottling: last ? last.mottling : "", descriptors: [], remarks: "", pocketPen: ""
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
                        <button id="anomalyButton_${idx}" type="button" onclick="openRockAnomalyEditor(${idx})" class="w-full table-input text-left text-xs font-semibold">
                            ${Array.isArray(r.anomalies) && r.anomalies.length ? `Anomalies (${r.anomalies.length})` : 'Add Anomaly'}
                        </button>
                    </td>
                    <td class="py-2.5 px-3">
                        <button id="remarksButton_rock_${idx}" type="button" onclick="openRemarksEditor('rock', ${idx}, this)" class="w-full table-input text-left text-xs font-semibold flex items-center space-x-2">
                            <i data-lucide="message-square-text" class="w-3.5 h-3.5 flex-shrink-0"></i>
                            <span data-remarks-label>${String(r.remarks || '').trim() ? 'Has Notes' : 'Add Remarks'}</span>
                        </button>
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
            if (field === 'remarks') {
                void saveLocal();
                return;
            }
            renderTables();
        }

        let remarksEditorTarget = null;
        let remarksEditorTrigger = null;
        let remarksEditorCursorStart = 0;
        let remarksEditorCursorEnd = 0;

        function getRemarksDepth(whole, decimal) {
            if (whole === null || whole === undefined || String(whole).trim() === '') return null;
            const wholeDepth = Number(whole);
            const decimalDepth = decimal === null || decimal === undefined || String(decimal).trim() === '' ? 0 : Number(decimal);
            return Number.isFinite(wholeDepth) && Number.isFinite(decimalDepth) ? wholeDepth + decimalDepth : null;
        }

        function openRemarksEditor(type, idx, trigger) {
            const boringIndex = activeBoringIndex;
            const boring = borings[boringIndex];
            const rows = type === 'soil' ? boring && boring.samples : boring && boring.rockSamples;
            const row = rows && rows[idx];
            if (!row) return;

            remarksEditorTarget = { type, boringIndex, index: idx };
            remarksEditorTrigger = trigger || null;
            document.getElementById('remarksEditorTitle').textContent = type === 'soil' ? 'Soil Remarks' : 'Rock Remarks';

            const topDepth = getRemarksDepth(row.whole, row.dec);
            const topDepthLabel = topDepth === null ? 'N/A' : `${topDepth.toFixed(1)} ft`;
            let details;
            if (type === 'soil') {
                details = [
                    ['Boring ID', boring.id || 'N/A'],
                    ['Depth', topDepthLabel],
                    ['Sample Type', row.type || 'N/A']
                ];
            } else {
                const runLengthText = String(row.runLength == null ? '' : row.runLength).trim();
                const runLength = Number(runLengthText);
                const bottomDepth = topDepth !== null && runLengthText !== '' && Number.isFinite(runLength) ? topDepth + runLength : null;
                details = [
                    ['Boring ID', boring.id || 'N/A'],
                    ['Top Depth', topDepthLabel],
                    ['Bottom Depth', bottomDepth === null ? 'N/A' : `${bottomDepth.toFixed(1)} ft`]
                ];
            }

            const detailsContainer = document.getElementById('remarksEditorDetails');
            detailsContainer.innerHTML = '';
            details.forEach(([label, value]) => {
                const item = document.createElement('div');
                item.className = 'rounded-lg bg-slate-100 dark:bg-slate-800 px-3 py-2';
                const name = document.createElement('div');
                name.className = 'text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400';
                name.textContent = label;
                const detail = document.createElement('div');
                detail.className = 'mt-0.5 text-sm font-semibold text-slate-800 dark:text-slate-100 break-words';
                detail.textContent = value;
                item.append(name, detail);
                detailsContainer.appendChild(item);
            });

            const pocketPenWrap = document.getElementById('remarksEditorPocketPenWrap');
            const pocketPenSelect = document.getElementById('remarksEditorPocketPen');
            pocketPenWrap.classList.toggle('hidden', type !== 'soil');
            if (type === 'soil') {
                pocketPenSelect.innerHTML = '<option value="">Not recorded</option>' +
                    Array.from({ length: 19 }, (_, index) => {
                        const value = (index * 0.25).toFixed(2);
                        return `<option value="${value}">${value} tsf</option>`;
                    }).join('');
                const pocketPenValue = String(row.pocketPen == null ? '' : row.pocketPen).trim();
                pocketPenSelect.value = pocketPenValue === '' ? '' : String(Number(pocketPenValue).toFixed(2));
            }

            const quickInserts = type === 'soil'
                ? ['DRILLER REMARK', 'GRASS ROOTS', 'TREE ROOTS', 'BRANCHES', 'ORGANICS', 'TRASH', 'ODOR', 'HARD DRILLING', ...(row.type === 'BULK' ? ['NUMBER OF BUCKETS'] : [])]
                : ['VOID/CAVITY', 'SOIL SEAM', '% CORE WATER LOSS', 'CORE LOSS', 'BROKEN CORE'];
            const quickInsertContainer = document.getElementById('remarksQuickInsertButtons');
            quickInsertContainer.innerHTML = '';
            quickInserts.forEach(text => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-bold text-amber-700 hover:bg-amber-500/20 dark:text-amber-300';
                button.textContent = text;
                button.addEventListener('click', () => insertRemarksQuickText(text));
                quickInsertContainer.appendChild(button);
            });

            const textarea = document.getElementById('remarksEditorTextarea');
            textarea.value = row.remarks || '';
            remarksEditorCursorStart = textarea.value.length;
            remarksEditorCursorEnd = textarea.value.length;
            document.getElementById('remarksEditorModal').classList.remove('hidden');
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }

        function updatePocketPenFromRemarksEditor(value) {
            if (!remarksEditorTarget || remarksEditorTarget.type !== 'soil') return;
            const boring = borings[remarksEditorTarget.boringIndex];
            const sample = boring && boring.samples && boring.samples[remarksEditorTarget.index];
            if (!sample) return;
            sample.pocketPen = value;
            markUnsaved();
            void saveLocal();
        }

        function rememberRemarksCursor() {
            const textarea = document.getElementById('remarksEditorTextarea');
            if (!textarea) return;
            remarksEditorCursorStart = textarea.selectionStart;
            remarksEditorCursorEnd = textarea.selectionEnd;
        }

        function updateRemarksEditor(value) {
            if (!remarksEditorTarget) return;
            const boring = borings[remarksEditorTarget.boringIndex];
            const rows = boring && (remarksEditorTarget.type === 'soil' ? boring.samples : boring.rockSamples);
            const row = rows && rows[remarksEditorTarget.index];
            if (!row) return;

            row.remarks = value;
            rememberRemarksCursor();
            const button = document.getElementById(`remarksButton_${remarksEditorTarget.type}_${remarksEditorTarget.index}`);
            const label = button && button.querySelector('[data-remarks-label]');
            if (label) label.textContent = String(value || '').trim() ? 'Has Notes' : 'Add Remarks';
            markUnsaved();
            void saveLocal();
        }

        function insertRemarksQuickText(text) {
            const textarea = document.getElementById('remarksEditorTextarea');
            if (!textarea || !remarksEditorTarget) return;

            const value = textarea.value;
            const start = Math.max(0, Math.min(remarksEditorCursorStart, value.length));
            const end = Math.max(start, Math.min(remarksEditorCursorEnd, value.length));
            const separator = start > 0 && value[start - 1] !== '\n' ? '\n' : '';
            const insertion = `${separator}${text}: `;
            textarea.value = value.slice(0, start) + insertion + value.slice(end);
            remarksEditorCursorStart = start + insertion.length;
            remarksEditorCursorEnd = remarksEditorCursorStart;
            textarea.focus();
            textarea.setSelectionRange(remarksEditorCursorStart, remarksEditorCursorEnd);
            updateRemarksEditor(textarea.value);
        }

        function closeRemarksEditor() {
            document.getElementById('remarksEditorModal').classList.add('hidden');
            remarksEditorTarget = null;
            if (remarksEditorTrigger && document.contains(remarksEditorTrigger)) remarksEditorTrigger.focus();
            remarksEditorTrigger = null;
        }

        const rockAnomalyTypes = ['Void', 'Soil Seam', 'Vug', 'Fossil', 'Vertical Joint', 'Other'];
        let rockAnomalyContext = null;
        let rockAnomalyDraft = [];
        let rockAnomalyRemarkIndex = null;

        function openRockAnomalyEditor(idx) {
            const boringIndex = activeBoringIndex;
            const run = borings[boringIndex] && borings[boringIndex].rockSamples && borings[boringIndex].rockSamples[idx];
            if (!run) return;

            rockAnomalyContext = { boringIndex, index: idx };
            rockAnomalyDraft = Array.isArray(run.anomalies)
                ? run.anomalies.filter(anomaly => anomaly && typeof anomaly === 'object').map(anomaly => ({
                    type: String(anomaly.type || ''),
                    topDepth: anomaly.topDepth == null ? '' : String(anomaly.topDepth),
                    length: anomaly.length == null ? '' : String(anomaly.length),
                    lengthInches: String(anomaly.lengthInches == null ? '' : anomaly.lengthInches).trim() ||
                        (Number.isFinite(Number(anomaly.length)) ? String((Number(anomaly.length) * 12).toFixed(2)) : ''),
                    otherRemark: String(anomaly.otherRemark || '')
                }))
                : [];
            const topDepth = getRemarksDepth(run.whole, run.dec);
            const runLength = Number.parseFloat(run.runLength);
            const bottomDepth = topDepth !== null && Number.isFinite(runLength) ? topDepth + runLength : null;
            document.getElementById('rockAnomalySubtitle').textContent =
                `Boring ${borings[boringIndex].id || 'N/A'} · Core run ${topDepth === null ? 'N/A' : `${topDepth.toFixed(1)} ft`} to ${bottomDepth === null ? 'N/A' : `${bottomDepth.toFixed(1)} ft`}`;
            clearRockAnomalyValidation();
            renderRockAnomalyRows();
            document.getElementById('rockAnomalyModal').classList.remove('hidden');
        }

        function clearRockAnomalyValidation() {
            const validation = document.getElementById('rockAnomalyValidation');
            validation.classList.add('hidden');
            validation.textContent = '';
        }

        function getRockAnomalyBottom(anomaly) {
            const topText = String(anomaly.topDepth == null ? '' : anomaly.topDepth).trim();
            if (!topText) return null;
            const top = Number(topText);
            const length = getRockAnomalyLengthFt(anomaly);
            return Number.isFinite(top) && Number.isFinite(length) ? top + length : null;
        }

        function convertRockAnomalyInchesToFeet(value) {
            const text = String(value == null ? '' : value).trim();
            if (!text) return null;
            const inches = Number(text);
            if (!Number.isFinite(inches) || inches <= 0) return null;
            return Number((Math.round(inches / 0.6 + Number.EPSILON) * 0.05).toFixed(2));
        }

        function getRockAnomalyLengthFt(anomaly) {
            const inches = String(anomaly.lengthInches == null ? '' : anomaly.lengthInches).trim();
            if (inches) return convertRockAnomalyInchesToFeet(inches);
            const legacyLength = String(anomaly.length == null ? '' : anomaly.length).trim();
            if (!legacyLength) return null;
            const length = Number(legacyLength);
            return Number.isFinite(length) ? length : null;
        }

        function renderRockAnomalyRows() {
            const tbody = document.getElementById('rockAnomalyTbody');
            tbody.replaceChildren();

            rockAnomalyDraft.forEach((anomaly, index) => {
                const row = document.createElement('tr');
                const typeCell = document.createElement('td');
                typeCell.className = 'p-2';
                const typeSelect = document.createElement('select');
                typeSelect.className = 'table-select min-w-32';
                typeSelect.innerHTML = `<option value="">Select type</option>${rockAnomalyTypes.map(type => `<option value="${type}">${type}</option>`).join('')}`;
                typeSelect.value = anomaly.type;
                typeSelect.addEventListener('change', () => {
                    anomaly.type = typeSelect.value;
                    clearRockAnomalyValidation();
                });
                typeCell.appendChild(typeSelect);

                const topCell = document.createElement('td');
                topCell.className = 'p-2';
                const topInput = document.createElement('input');
                topInput.type = 'number';
                topInput.step = '0.05';
                topInput.className = 'table-input min-w-28';
                topInput.placeholder = 'e.g. 18.5';
                topInput.value = anomaly.topDepth;
                const bottomCell = document.createElement('td');
                bottomCell.className = 'p-2 text-right font-semibold';
                const bottomOutput = document.createElement('span');
                bottomOutput.textContent = getRockAnomalyBottom(anomaly) === null ? '--' : `${getRockAnomalyBottom(anomaly).toFixed(2)} ft`;
                topInput.addEventListener('input', () => {
                    anomaly.topDepth = topInput.value;
                    updateBottomOutput();
                });
                topCell.appendChild(topInput);

                const lengthCell = document.createElement('td');
                lengthCell.className = 'p-2';
                const lengthInput = document.createElement('input');
                lengthInput.type = 'number';
                lengthInput.step = '0.1';
                lengthInput.min = '0.3';
                lengthInput.className = 'table-input min-w-24';
                lengthInput.placeholder = 'e.g. 6';
                lengthInput.value = anomaly.lengthInches;
                lengthInput.addEventListener('input', () => {
                    anomaly.lengthInches = lengthInput.value;
                    const convertedLength = convertRockAnomalyInchesToFeet(lengthInput.value);
                    anomaly.length = convertedLength === null ? '' : convertedLength.toFixed(2);
                    updateBottomOutput();
                });
                lengthCell.appendChild(lengthInput);
                bottomCell.appendChild(bottomOutput);

                const lengthFeetCell = document.createElement('td');
                lengthFeetCell.className = 'p-2 text-right font-semibold text-slate-600 dark:text-slate-300';
                const lengthFeetOutput = document.createElement('span');
                const initialLengthFt = getRockAnomalyLengthFt(anomaly);
                lengthFeetOutput.textContent = initialLengthFt === null ? '--' : `${initialLengthFt.toFixed(2)} ft`;
                lengthFeetCell.appendChild(lengthFeetOutput);

                const remarkCell = document.createElement('td');
                remarkCell.className = 'p-2';
                const remarkButton = document.createElement('button');
                remarkButton.type = 'button';
                remarkButton.className = 'table-input min-w-32 text-left';
                remarkButton.textContent = anomaly.otherRemark.trim() || 'Add remark';
                remarkButton.addEventListener('click', () => openRockAnomalyRemarkEditor(index));
                remarkCell.appendChild(remarkButton);

                const removeCell = document.createElement('td');
                removeCell.className = 'p-2 text-center';
                const removeButton = document.createElement('button');
                removeButton.type = 'button';
                removeButton.className = 'rounded px-2 py-1 font-bold text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40';
                removeButton.textContent = 'Remove';
                removeButton.addEventListener('click', () => {
                    rockAnomalyDraft.splice(index, 1);
                    clearRockAnomalyValidation();
                    renderRockAnomalyRows();
                });
                removeCell.appendChild(removeButton);
                row.append(typeCell, topCell, lengthCell, lengthFeetCell, bottomCell, remarkCell, removeCell);
                tbody.appendChild(row);

                function updateBottomOutput() {
                    const convertedLength = convertRockAnomalyInchesToFeet(anomaly.lengthInches);
                    anomaly.length = convertedLength === null ? '' : convertedLength.toFixed(2);
                    lengthFeetOutput.textContent = convertedLength === null ? '--' : `${convertedLength.toFixed(2)} ft`;
                    const bottom = getRockAnomalyBottom(anomaly);
                    bottomOutput.textContent = bottom === null ? '--' : `${bottom.toFixed(2)} ft`;
                    clearRockAnomalyValidation();
                }
            });
        }

        function addRockAnomalyRow() {
            rockAnomalyDraft.push({ type: '', topDepth: '', length: '', lengthInches: '', otherRemark: '' });
            clearRockAnomalyValidation();
            renderRockAnomalyRows();
        }

        function openRockAnomalyRemarkEditor(index) {
            rockAnomalyRemarkIndex = index;
            document.getElementById('rockAnomalyRemarkInput').value = rockAnomalyDraft[index].otherRemark;
            document.getElementById('rockAnomalyRemarkModal').classList.remove('hidden');
            document.getElementById('rockAnomalyRemarkInput').focus();
        }

        function closeRockAnomalyRemarkEditor() {
            document.getElementById('rockAnomalyRemarkModal').classList.add('hidden');
            rockAnomalyRemarkIndex = null;
        }

        function saveRockAnomalyRemark() {
            if (rockAnomalyRemarkIndex === null || !rockAnomalyDraft[rockAnomalyRemarkIndex]) return;
            rockAnomalyDraft[rockAnomalyRemarkIndex].otherRemark = document.getElementById('rockAnomalyRemarkInput').value.trim();
            closeRockAnomalyRemarkEditor();
            renderRockAnomalyRows();
        }

        function closeRockAnomalyModal() {
            document.getElementById('rockAnomalyRemarkModal').classList.add('hidden');
            document.getElementById('rockAnomalyModal').classList.add('hidden');
            rockAnomalyContext = null;
            rockAnomalyDraft = [];
            rockAnomalyRemarkIndex = null;
        }

        function saveRockAnomalies() {
            if (!rockAnomalyContext) return;
            const boring = borings[rockAnomalyContext.boringIndex];
            const run = boring && boring.rockSamples && boring.rockSamples[rockAnomalyContext.index];
            if (!run) return;

            const runTop = getRemarksDepth(run.whole, run.dec);
            const runLength = Number.parseFloat(run.runLength);
            const runBottom = runTop !== null && Number.isFinite(runLength) ? runTop + runLength : null;
            const errors = [];
            const anomalies = [];
            rockAnomalyDraft.forEach((anomaly, index) => {
                const type = String(anomaly.type || '').trim();
                const topText = String(anomaly.topDepth == null ? '' : anomaly.topDepth).trim();
                const lengthInchesText = String(anomaly.lengthInches == null ? '' : anomaly.lengthInches).trim();
                const remark = String(anomaly.otherRemark || '').trim();
                if (!type && !topText && !lengthInchesText && !remark) return;

                const rowNumber = index + 1;
                const top = topText === '' ? NaN : Number(topText);
                const lengthInches = lengthInchesText === '' ? NaN : Number(lengthInchesText);
                const length = convertRockAnomalyInchesToFeet(lengthInchesText);
                if (!rockAnomalyTypes.includes(type)) errors.push(`Row ${rowNumber}: choose an anomaly type.`);
                if (!Number.isFinite(top)) errors.push(`Row ${rowNumber}: enter a valid top depth.`);
                if (!Number.isFinite(lengthInches) || lengthInches <= 0 || length === null || length <= 0) {
                    errors.push(`Row ${rowNumber}: enter a positive length in inches that converts to at least 0.05 ft.`);
                }
                if (Number.isFinite(top) && Number.isFinite(length) && length > 0) {
                    const bottom = top + length;
                    if (runTop === null || runBottom === null || top < runTop - 1e-9 || bottom > runBottom + 1e-9) {
                        errors.push(`Row ${rowNumber}: anomaly must stay within the core run (${runTop === null || runBottom === null ? 'valid run depths unavailable' : `${runTop.toFixed(1)}–${runBottom.toFixed(1)} ft`}).`);
                    }
                }
                if (rockAnomalyTypes.includes(type) && Number.isFinite(top) && Number.isFinite(length) && length > 0 &&
                    runTop !== null && runBottom !== null && top >= runTop - 1e-9 && top + length <= runBottom + 1e-9) {
                    anomalies.push({
                        type,
                        topDepth: topText,
                        length: length.toFixed(2),
                        lengthInches: lengthInchesText,
                        otherRemark: remark
                    });
                }
            });

            if (errors.length) {
                const validation = document.getElementById('rockAnomalyValidation');
                validation.textContent = errors.join(' ');
                validation.classList.remove('hidden');
                return;
            }

            run.anomalies = anomalies;
            markUnsaved();
            void saveLocal();
            renderTables();
            closeRockAnomalyModal();
        }

        function getDefaultRockStartDepth(boring) {
            const refusalValue = boring.refusalDepth;
            const refusalDepth = Number(refusalValue);
            if (refusalValue !== null && refusalValue !== undefined && String(refusalValue).trim() !== "" && Number.isFinite(refusalDepth)) {
                return refusalDepth;
            }

            let deepestSampleBottom = null;
            (boring.samples || []).forEach(sample => {
                const whole = Number(sample.whole);
                const decimal = Number(sample.dec || 0);
                if (sample.whole === null || sample.whole === undefined || String(sample.whole).trim() === "" || !Number.isFinite(whole) || !Number.isFinite(decimal)) return;

                const lengthText = String(sample.length || "18").replace(/[^0-9.]/g, '');
                const lengthInches = parseFloat(lengthText) || 18.0;
                const sampleBottom = whole + decimal + lengthInches / 12.0;
                deepestSampleBottom = deepestSampleBottom === null
                    ? sampleBottom
                    : Math.max(deepestSampleBottom, sampleBottom);
            });

            return deepestSampleBottom === null ? 0.0 : deepestSampleBottom;
        }

        function addRockRow() {
            const activeBoring = borings[activeBoringIndex];
            if (!activeBoring.rockSamples) activeBoring.rockSamples = [];
            
            const isFirstRun = (activeBoring.rockSamples.length === 0);
            let nextTop = isFirstRun ? getDefaultRockStartDepth(activeBoring) : 0.0;
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
                jointAperture: "", jointFilling: "", gwCondition: "", natFractures: "0", descriptors: [], remarks: "", anomalies: []
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

        function abbreviateProfileSurfaceLabel(value) {
            const label = String(value || '').trim();
            const abbreviations = {
                'mineral aggregate base': 'M. A. Base',
                'crushed stone base': 'C. Stone Base',
                'structural fill': 'S. Fill',
                'existing fill': 'E. Fill',
                'asphalt millings': 'A. Millings',
                'landscaping rock': 'Land. Rock',
                'crushed concrete': 'C. Concrete'
            };
            if (abbreviations[label.toLowerCase()]) return abbreviations[label.toLowerCase()];
            if (label.length <= 'Structural Fill'.length) return label;
            const words = label.split(/\s+/);
            return words.length > 1
                ? `${words.slice(0, -1).map(word => `${word[0]}.`).join(' ')} ${words[words.length - 1]}`
                : `${label.slice(0, 12)}…`;
        }

        function escapeProfileSvgText(value) {
            return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
            })[character]);
        }

        function getRockQualityMarkers(rockSamples, getDepth) {
            return rockSamples.map(sample => {
                const runLength = Number.parseFloat(sample.runLength);
                const recovery = Number.parseFloat(sample.recovery);
                const rqd = Number.parseFloat(sample.rqd);
                return {
                    top: getDepth(sample),
                    recoveryPercent: Number.isFinite(runLength) && runLength > 0 && Number.isFinite(recovery)
                        ? (recovery / runLength) * 100
                        : NaN,
                    rqdPercent: Number.isFinite(runLength) && runLength > 0 && Number.isFinite(rqd)
                        ? (rqd / runLength) * 100
                        : NaN
                };
            }).filter(marker => Number.isFinite(marker.top) &&
                (Number.isFinite(marker.recoveryPercent) || Number.isFinite(marker.rqdPercent)));
        }

        function getRockAnomalyMarkers(rockSamples, getDepth) {
            return rockSamples.flatMap(sample => {
                const runTop = getDepth(sample);
                if (!Number.isFinite(runTop) || !Array.isArray(sample.anomalies)) return [];
                return sample.anomalies.map(anomaly => {
                    const topText = String(anomaly && anomaly.topDepth != null ? anomaly.topDepth : '').trim();
                    const top = topText ? Number(topText) : NaN;
                    const length = anomaly ? getRockAnomalyLengthFt(anomaly) : null;
                    if (!Number.isFinite(top) || !Number.isFinite(length) || length <= 0) return null;
                    const lengthText = Number(length.toFixed(2)).toString();
                    const type = String(anomaly.type || 'Anomaly').trim() || 'Anomaly';
                    return { top, label: `${type} ${lengthText}'` };
                }).filter(Boolean);
            });
        }

        function layoutProfileMarkerLabels(markers, startY, maxDepth, pxPerFoot) {
            const prepared = markers.map(marker => ({
                ...marker,
                targetY: startY + marker.top * pxPerFoot
            })).sort((a, b) => a.targetY - b.targetY || a.priority - b.priority);
            const positioned = [];
            let cluster = [];

            const placeCluster = () => {
                if (!cluster.length) return;
                cluster.sort((a, b) => a.priority - b.priority || a.targetY - b.targetY);
                const gap = 2;
                const totalHeight = cluster.reduce((sum, marker) => sum + marker.height, 0) + gap * (cluster.length - 1);
                const targetCenter = cluster.reduce((sum, marker) => sum + marker.targetY, 0) / cluster.length;
                let top = targetCenter - totalHeight / 2;
                const minTop = startY + 1;
                const maxBottom = startY + maxDepth * pxPerFoot - 1;
                if (top < minTop) top = minTop;
                if (top + totalHeight > maxBottom) top = maxBottom - totalHeight;

                cluster.forEach(marker => {
                    const centerY = top + marker.height / 2;
                    positioned.push({ ...marker, centerY });
                    top += marker.height + gap;
                });
                cluster = [];
            };

            prepared.forEach(marker => {
                const previous = cluster[cluster.length - 1];
                if (previous && marker.targetY - previous.targetY > (previous.height + marker.height) / 2 + 2) {
                    placeCluster();
                }
                cluster.push(marker);
            });
            placeCluster();
            return positioned;
        }

        function renderProfileRightMarkersSvg(sampleMarkers, rockMarkers, colX, colWidth, startY, maxDepth, pxPerFoot) {
            const markers = [
                ...sampleMarkers.map(marker => ({
                    ...marker,
                    kind: 'n-value',
                    height: 16,
                    priority: 0
                })),
                ...rockMarkers.map(marker => ({
                    ...marker,
                    kind: 'rock-quality',
                    height: 24,
                    priority: 1
                }))
            ];
            return layoutProfileMarkerLabels(markers, startY, maxDepth, pxPerFoot).map(marker => {
                const x = colX + colWidth + 6;
                const width = 54;
                const title = marker.kind === 'n-value'
                    ? (marker.nVal === 'Refusal' ? 'N=REF' : `N=${marker.nVal}`)
                    : [
                        Number.isFinite(marker.recoveryPercent) ? `REC ${marker.recoveryPercent.toFixed(0)}%` : '',
                        Number.isFinite(marker.rqdPercent) ? `RQD ${marker.rqdPercent.toFixed(0)}%` : ''
                    ].filter(Boolean).join(' / ');
                const leader = `<path d="M ${colX + colWidth} ${marker.targetY} L ${x} ${marker.centerY}" fill="none" stroke="#64748b" stroke-width="1.2" />`;
                if (marker.kind === 'n-value') {
                    const nText = marker.nVal === 'Refusal' ? 'N=REF' : `N=${marker.nVal}`;
                    return `${leader}<rect x="${x}" y="${marker.centerY - marker.height / 2}" width="42" height="16" rx="3" fill="#1e293b" opacity="0.96"><title>${escapeProfileSvgText(title)}</title></rect><text x="${x + 21}" y="${marker.centerY + 3.5}" text-anchor="middle" font-weight="700" font-size="9" fill="#f8fafc">${escapeProfileSvgText(nText)}</text>`;
                }

                const labels = [
                    Number.isFinite(marker.recoveryPercent) ? `REC ${marker.recoveryPercent.toFixed(0)}%` : '',
                    Number.isFinite(marker.rqdPercent) ? `RQD ${marker.rqdPercent.toFixed(0)}%` : ''
                ].filter(Boolean);
                const rowSpacing = labels.length > 1 ? 10 : 0;
                const text = labels.map((label, index) => {
                    const y = marker.centerY + (index - (labels.length - 1) / 2) * rowSpacing + 2.8;
                    return `<text x="${x + 27}" y="${y}" text-anchor="middle" font-weight="700" font-size="7.5" fill="#ffffff">${label}</text>`;
                }).join('');
                return `${leader}<rect x="${x}" y="${marker.centerY - marker.height / 2}" width="${width}" height="${marker.height}" rx="3" fill="#4b5563" opacity="0.96"><title>${escapeProfileSvgText(title)}</title></rect>${text}`;
            }).join('');
        }

        function renderProfileLeftMarkersSvg(groundwaterMarkers, anomalyMarkers, colX, startY, maxDepth, pxPerFoot) {
            const markers = [
                ...anomalyMarkers.map(marker => ({
                    ...marker,
                    kind: 'anomaly',
                    height: 16,
                    priority: 0
                })),
                ...groundwaterMarkers.map(marker => ({
                    ...marker,
                    kind: 'groundwater',
                    height: 16,
                    priority: 1
                }))
            ];
            return layoutProfileMarkerLabels(markers, startY, maxDepth, pxPerFoot).map(marker => {
                const color = marker.kind === 'anomaly' ? '#7c3aed' : '#0284c7';
                const width = Math.min(90, Math.max(46, marker.label.length * 4 + 10));
                const x = colX - width - 8;
                const fullLabel = escapeProfileSvgText(marker.label);
                const maxChars = Math.max(8, Math.floor((width - 10) / 4));
                const visibleLabel = marker.label.length > maxChars
                    ? `${escapeProfileSvgText(marker.label.slice(0, maxChars - 1))}…`
                    : fullLabel;
                const leader = `<path d="M ${x + width} ${marker.centerY} L ${colX - 12} ${marker.centerY} L ${colX - 6} ${marker.targetY}" fill="none" stroke="${color}" stroke-width="1.2" />`;
                const label = `<rect x="${x}" y="${marker.centerY - 8}" width="${width}" height="16" rx="3" fill="${color}" opacity="0.96"><title>${fullLabel}</title></rect><text x="${x + width / 2}" y="${marker.centerY + 3}" text-anchor="middle" font-weight="700" font-size="7.5" fill="#f8fafc">${visibleLabel}</text>`;
                const depthTick = `<polygon points="${colX},${marker.targetY} ${colX - 6},${marker.targetY - 4} ${colX - 6},${marker.targetY + 4}" fill="${color}" />`;
                return `${leader}${label}${depthTick}`;
            }).join('');
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
                layers.push({ top: layerTop, bot: layerBot, uscs: scType.toUpperCase(), surfaceLabel: scType, type: 'SURFACE', description: `${sc.thickness || 0}" ${scType}${sc.remarks ? ' (' + sc.remarks + ')' : ''}` });
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
            const rockMarkers = getRockQualityMarkers(rockSamples, sample => parseFloat(sample.whole) + parseFloat(sample.dec));
            const anomalyMarkers = getRockAnomalyMarkers(rockSamples, sample => parseFloat(sample.whole) + parseFloat(sample.dec));
            const gwMarkers = (curBoring.gw || []).map(gw => {
                const depthVal = parseFloat(gw.depth);
                if (isNaN(depthVal)) return null;
                const label = getGWProfileLabel(gw);
                return (!label || label === "N/A") ? null : { top: depthVal, label: label };
            }).filter(Boolean);

            renderLiveProfileSVG(layers, sampleMarkers, rockMarkers, gwMarkers, anomalyMarkers, totalDepth);
            renderLiveProfileTable(layers);
        }

        function renderLiveProfileSVG(layers, sampleMarkers, rockMarkers, gwMarkers, anomalyMarkers, maxDepth) {
            const container = document.getElementById('liveProfileSvgContainer');
            if (!container) return;
            const svgWidth = 350;
            const pxPerFoot = Math.min(26, Math.max(12, 360 / (maxDepth || 30)));
            const svgHeight = Math.max(340, (maxDepth * pxPerFoot) + 50);
            const colX = 105, colWidth = 100, startY = 25;

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
                const displayText = l.type === 'SURFACE'
                    ? abbreviateProfileSurfaceLabel(l.surfaceLabel || l.uscs)
                    : l.uscs || l.rockType || "";
                if (layerHeight > 16 && displayText) {
                    const fullSurfaceLabel = l.type === 'SURFACE' ? `<title>${escapeProfileSvgText(l.surfaceLabel || l.uscs)}</title>` : '';
                    svg += `<text x="${colX + colWidth/2}" y="${midY + 3.5}" text-anchor="middle" font-weight="800" font-size="10" fill="${sym.textColor}" stroke="${sym.fill}" stroke-width="2.5" paint-order="stroke fill">${fullSurfaceLabel}${escapeProfileSvgText(displayText)}</text>`;
                }
            });

            svg += renderProfileRightMarkersSvg(sampleMarkers, rockMarkers, colX, colWidth, startY, maxDepth, pxPerFoot);
            svg += renderProfileLeftMarkersSvg(gwMarkers, anomalyMarkers, colX, startY, maxDepth, pxPerFoot);

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
                    <label class="flex items-center space-x-1.5 p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer transition">
                        <input type="checkbox" ${isChecked ? 'checked' : ''} onchange="onProfileCheckboxChange('${b.id}', this.checked)" class="w-4 h-4 accent-amber-500 rounded">
                        <span class="font-bold text-xs text-slate-700 dark:text-slate-200">${b.id}</span>
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
                        <p class="text-xs text-slate-400">Check one or more borings on the left panel to build a shared-scale cross-section.</p>
                    </div>
                `;
                if (typeof lucide !== 'undefined') lucide.createIcons();
                return;
            }

            const escapeSvgText = value => String(value == null ? '' : value)
                .replace(/[&<>"']/g, character => ({
                    '&': '&amp;',
                    '<': '&lt;',
                    '>': '&gt;',
                    '"': '&quot;',
                    "'": '&#39;'
                })[character]);
            const profiles = selectedBorings.map(b => {
                const surfaceConditions = b.surfaceConditions || [];
                const soilSamples = b.samples || [];
                const rockSamples = b.rockSamples || [];
                const totalDepth = Math.max(0, parseFloat(b.totalDepth) || 0);
                const sampleDepth = sample => (parseFloat(sample.whole) || 0) + (parseFloat(sample.dec) || 0);

                const layers = [];
                let currentSurfaceDepth = 0.0;
                surfaceConditions.forEach(sc => {
                    const thickInches = parseFloat(sc.thickness) || 0;
                    const thickFeet = thickInches / 12.0;
                    const layerTop = currentSurfaceDepth;
                    const layerBot = currentSurfaceDepth + thickFeet;
                    currentSurfaceDepth = layerBot;
                    layers.push({ top: layerTop, bot: layerBot, uscs: (sc.type || 'SURFACE').toUpperCase(), surfaceLabel: sc.type || 'SURFACE', type: 'SURFACE' });
                });

                soilSamples.forEach((current, i) => {
                    let layerTop = (i === 0) ? ((surfaceConditions.length > 0) ? currentSurfaceDepth : 0.0) : sampleDepth(current);
                    let layerBot;
                    if (i < soilSamples.length - 1) {
                        layerBot = sampleDepth(soilSamples[i + 1]);
                    } else if (rockSamples.length > 0) {
                        layerBot = sampleDepth(rockSamples[0]);
                    } else {
                        layerBot = Math.max(totalDepth, layerTop + 3.0);
                    }
                    if (layerBot < layerTop) layerBot = layerTop;
                    layers.push({ top: layerTop, bot: layerBot, uscs: current.uscs ? current.uscs.toUpperCase() : 'UNCLASSIFIED', type: 'SOIL' });
                });

                rockSamples.forEach(r => {
                    const top = (parseFloat(r.whole) || 0) + (parseFloat(r.dec) || 0);
                    const bot = top + (parseFloat(r.runLength) || 5.0);
                    const rockTypeStr = (r.rockType || 'ROCK').toUpperCase();
                    layers.push({ top, bot, uscs: rockTypeStr, type: 'ROCK', rockType: rockTypeStr });
                });

                const sampleMarkers = soilSamples.map(s => ({
                    top: sampleDepth(s),
                    nVal: computeN(s.b2, s.b3, s.b1)
                })).filter(m => m.nVal !== undefined && m.nVal !== "" && m.nVal !== null);
                const rockMarkers = getRockQualityMarkers(rockSamples, sampleDepth);
                const anomalyMarkers = getRockAnomalyMarkers(rockSamples, sampleDepth);
                const gwMarkers = (b.gw || []).map(gw => {
                    const depthVal = parseFloat(gw.depth);
                    if (isNaN(depthVal)) return null;
                    const label = getGWProfileLabel(gw);
                    return (!label || label === "N/A") ? null : { top: depthVal, label: label };
                }).filter(Boolean);

                const depthCandidates = [
                    totalDepth,
                    ...layers.map(layer => layer.bot),
                    ...sampleMarkers.map(marker => marker.top),
                    ...rockMarkers.map(marker => marker.top),
                    ...anomalyMarkers.map(marker => marker.top),
                    ...gwMarkers.map(marker => marker.top)
                ].filter(Number.isFinite);
                const deepestLoggedDepth = Math.max(...depthCandidates, 0);
                return { boring: b, layers, sampleMarkers, rockMarkers, gwMarkers, anomalyMarkers, depth: deepestLoggedDepth };
            });

            const maxProjectDepth = Math.max(...profiles.map(profile => profile.depth), 0) || 30;
            const axisX = 58;
            const firstColumnX = 110;
            const columnPitch = 250;
            const colWidth = 88;
            const startY = 54;
            const plotHeight = maxProjectDepth * Math.min(22, Math.max(12, 450 / maxProjectDepth));
            const pxPerFoot = plotHeight / maxProjectDepth;
            const svgHeight = startY + plotHeight + 20;
            const svgWidth = firstColumnX + (profiles.length * columnPitch) + 12;
            const clipWidth = svgWidth - 16;
            let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}" class="block font-sans text-xs select-none" style="max-width:none;flex:none">`;
            svg += `<defs>
                <clipPath id="profiles-plot-clip"><rect x="8" y="${startY}" width="${clipWidth}" height="${plotHeight}" /></clipPath>
                <pattern id="profiles-hatch-rock" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="8" y2="0" stroke="#0f172a" stroke-width="2.2" /></pattern>
                <pattern id="profiles-hatch-fill" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="6" y2="0" stroke="#ffffff" stroke-width="1.8" /><line x1="0" y1="0" x2="0" y2="6" stroke="#ffffff" stroke-width="1.8" /></pattern>
                <pattern id="profiles-hatch-gravel" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="5" cy="5" r="2.5" fill="none" stroke="#0f172a" stroke-width="1.8" /></pattern>
                <pattern id="profiles-hatch-sand" width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1.5" fill="#713f12" /></pattern>
                <pattern id="profiles-hatch-silt" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><line x1="0" y1="0" x2="0" y2="8" stroke="#1e3a8a" stroke-width="2.0" /></pattern>
                <pattern id="profiles-hatch-silt-dark" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><line x1="0" y1="0" x2="0" y2="8" stroke="#ffffff" stroke-width="2.0" /></pattern>
                <pattern id="profiles-hatch-clay" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" stroke="#7f1d1d" stroke-width="2.0" /></pattern>
                <pattern id="profiles-hatch-clay-high" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#fee2e2" stroke-width="1.8" /><line x2="2" y1="0" x2="2" y2="6" stroke="#fee2e2" stroke-width="1.8" /></pattern>
                <pattern id="profiles-hatch-organic" width="8" height="8" patternUnits="userSpaceOnUse"><line x1="0" y1="0" x2="8" y2="8" stroke="#052e16" stroke-width="2.0" /><line x1="8" y1="0" x2="0" y2="8" stroke="#052e16" stroke-width="2.0" /></pattern>
                <pattern id="profiles-hatch-topsoil" width="10" height="10" patternUnits="userSpaceOnUse"><polygon points="5,1 9,9 1,9" fill="none" stroke="#fffbeb" stroke-width="1.6" /></pattern>
                <pattern id="profiles-hatch-asphalt" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(30)"><line x1="0" y1="0" x2="8" y2="0" stroke="#52525b" stroke-width="1.5" /></pattern>
                <pattern id="profiles-hatch-concrete" width="6" height="6" patternUnits="userSpaceOnUse"><rect x="0" y="0" width="3" height="3" fill="#94a3b8" opacity="0.3"/></pattern>
                <pattern id="profiles-hatch-riprap" width="12" height="12" patternUnits="userSpaceOnUse"><path d="M2,2 L8,2 L10,8 L4,10 Z" fill="none" stroke="#0f172a" stroke-width="1.8"/></pattern>
                <pattern id="profiles-hatch-void" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#dc2626" stroke-width="2.0" /></pattern>
                <pattern id="profiles-hatch-unknown" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="8" y2="0" stroke="#3b0764" stroke-width="1.8" /></pattern>
            </defs>`;
            svg += `<text x="14" y="26" text-anchor="middle" font-weight="700" font-size="10" fill="#64748b" transform="rotate(-90 14 26)">Depth (ft)</text>`;

            const tickDepths = [];
            for (let depth = 0; depth <= maxProjectDepth; depth += 5) tickDepths.push(depth);
            if (tickDepths[tickDepths.length - 1] < maxProjectDepth) tickDepths.push(maxProjectDepth);
            tickDepths.forEach(depth => {
                const y = startY + (depth * pxPerFoot);
                svg += `<line x1="${axisX}" y1="${y}" x2="${svgWidth - 8}" y2="${y}" stroke="#cbd5e1" stroke-dasharray="3,3" opacity="0.65" />`;
                svg += `<line x1="${axisX - 4}" y1="${y}" x2="${axisX}" y2="${y}" stroke="#64748b" stroke-width="1.5" />`;
                svg += `<text x="${axisX - 8}" y="${y + 3}" text-anchor="end" font-weight="600" font-size="9" fill="#64748b">${Number(depth.toFixed(1))}'</text>`;
            });
            svg += `<line x1="${axisX}" y1="${startY}" x2="${axisX}" y2="${startY + plotHeight}" stroke="#64748b" stroke-width="2" />`;

            profiles.forEach((profile, index) => {
                const slotX = firstColumnX + (index * columnPitch);
                const colX = slotX + 54;
                const boringId = escapeSvgText(profile.boring.id || 'Boring');
                const totalDepthLabel = escapeSvgText(profile.boring.totalDepth || '0.0');
                svg += `<text x="${colX + colWidth / 2}" y="19" text-anchor="middle" font-weight="800" font-size="12" fill="#d97706"><title>${boringId}</title>${boringId}</text>`;
                svg += `<text x="${colX + colWidth / 2}" y="36" text-anchor="middle" font-weight="600" font-size="9" fill="#64748b">TD: ${totalDepthLabel} ft</text>`;
            });

            svg += `<g clip-path="url(#profiles-plot-clip)">`;
            profiles.forEach((profile, index) => {
                const slotX = firstColumnX + (index * columnPitch);
                const colX = slotX + 54;
                svg += `<line x1="${colX}" y1="${startY}" x2="${colX}" y2="${startY + plotHeight}" stroke="#64748b" stroke-width="1" />`;

                profile.layers.forEach(layer => {
                    const layerTop = Math.max(0, layer.top);
                    const layerBottom = Math.min(maxProjectDepth, layer.bot);
                    if (!Number.isFinite(layerTop) || !Number.isFinite(layerBottom) || layerBottom <= layerTop) return;
                    const layerTopY = startY + (layerTop * pxPerFoot);
                    const layerHeight = Math.max(1, (layerBottom - layerTop) * pxPerFoot);
                    const sym = getGeotechSymbology(layer.uscs || layer.rockType, layer.type);
                    const patternId = `profiles-${sym.hatch}`;
                    svg += `<rect x="${colX}" y="${layerTopY}" width="${colWidth}" height="${layerHeight}" fill="${sym.fill}" stroke="#0f172a" stroke-width="1.2" />`;
                    svg += `<rect x="${colX}" y="${layerTopY}" width="${colWidth}" height="${layerHeight}" fill="url(#${patternId})" opacity="0.85" stroke="#0f172a" stroke-width="1.2" />`;

                    const midY = layerTopY + (layerHeight / 2);
                    const displayText = escapeSvgText(layer.type === 'SURFACE'
                        ? abbreviateProfileSurfaceLabel(layer.surfaceLabel || layer.uscs)
                        : layer.uscs || layer.rockType || '');
                    if (layerHeight > 16 && displayText) {
                        const fullSurfaceLabel = layer.type === 'SURFACE' ? `<title>${escapeSvgText(layer.surfaceLabel || layer.uscs)}</title>` : '';
                        svg += `<text x="${colX + colWidth / 2}" y="${midY + 3.5}" text-anchor="middle" font-weight="800" font-size="10" fill="${sym.textColor}" stroke="${sym.fill}" stroke-width="2.5" paint-order="stroke fill">${fullSurfaceLabel}${displayText}</text>`;
                    }
                });

                svg += renderProfileRightMarkersSvg(
                    profile.sampleMarkers, profile.rockMarkers, colX, colWidth, startY, maxProjectDepth, pxPerFoot
                );
                svg += renderProfileLeftMarkersSvg(
                    profile.gwMarkers, profile.anomalyMarkers, colX, startY, maxProjectDepth, pxPerFoot
                );
            });

            svg += `</g></svg>`;
            container.innerHTML = svg;
        }

        // --- Summary Figures & Percentage Histograms ---
        let uscsChartInstance = null;
        let soilRockChartInstance = null;
        let recoveryHistInstance = null;
        let rqdHistInstance = null;
        let sampleSummarySort = { key: 'boring', direction: 1 };
        let sampleSummaryTypeFilter = 'ALL';

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

            renderGroundwaterSummary();
            renderSampleSummaryTable();
            renderUSCSPieChart(uscsFootageMap);
            renderSoilRockPieChart(totalSoilFootageAll, totalRockFootageAll);
            renderPercentageHistogram('recoveryHistogram', recoveryPercentages, 'Recovery Quality (%)', '#10b981');
            renderPercentageHistogram('rqdHistogram', rqdPercentages, 'RQD Quality (%)', '#3b82f6');
        }

        function renderGroundwaterSummary() {
            const categories = ['ATD', 'AD', 'Next Day', 'After Coring', 'After Rotary Wash', 'Other'];
            const categoryStats = new Map(categories.map(category => [category, { depths: [], borings: new Set() }]));
            let boringsWithWater = 0;
            let boringsWithoutWater = 0;

            borings.forEach((boring, boringIndex) => {
                let hasWater = false;
                (boring.gw || []).forEach(observation => {
                    if (!observation) return;
                    const rawDepth = String(observation.depth == null ? '' : observation.depth).trim();
                    if (rawDepth === '') return;
                    const depth = Number(rawDepth);
                    if (!Number.isFinite(depth)) return;

                    const observationType = normalizeGroundwaterObservationType(observation.time);
                    if (observationType.toLowerCase() === 'cave in') return;
                    hasWater = true;

                    const stats = categoryStats.get(observationType);
                    if (stats) {
                        stats.depths.push(depth);
                        stats.borings.add(boringIndex);
                    }
                });

                if (hasWater) boringsWithWater++;
                else boringsWithoutWater++;
            });

            document.getElementById('gwStatWithWater').textContent = boringsWithWater;
            document.getElementById('gwStatWithoutWater').textContent = boringsWithoutWater;

            const tbody = document.getElementById('gwCategorySummaryTbody');
            tbody.replaceChildren();
            categories.forEach(category => {
                const stats = categoryStats.get(category);
                const depths = stats.depths;
                const minDepth = depths.reduce((minimum, depth) => Math.min(minimum, depth), Infinity);
                const maxDepth = depths.reduce((maximum, depth) => Math.max(maximum, depth), -Infinity);
                const values = depths.length
                    ? [
                        category,
                        `${minDepth.toFixed(1)} ft`,
                        `${maxDepth.toFixed(1)} ft`,
                        `${(depths.reduce((sum, depth) => sum + depth, 0) / depths.length).toFixed(1)} ft`,
                        String(depths.length),
                        String(stats.borings.size)
                    ]
                    : [category, '--', '--', '--', '0', '0'];
                const row = document.createElement('tr');
                row.className = 'hover:bg-slate-50 dark:hover:bg-slate-800/40';
                values.forEach((value, index) => {
                    const cell = document.createElement('td');
                    cell.className = index === 0
                        ? 'py-2 px-3 font-semibold text-sky-700 dark:text-sky-300'
                        : 'py-2 px-3 text-right';
                    cell.textContent = value;
                    row.appendChild(cell);
                });
                tbody.appendChild(row);
            });
        }

        function getSummaryNumber(value) {
            const text = String(value == null ? '' : value).trim();
            if (text === '') return null;
            const number = Number.parseFloat(text);
            return Number.isFinite(number) ? number : null;
        }

        function compareNullableNumbers(a, b) {
            if (a == null) return b == null ? 0 : 1;
            if (b == null) return -1;
            return a - b;
        }

        function compareSampleSummaryValues(a, b, key) {
            const aValue = a.sort[key];
            const bValue = b.sort[key];
            if (aValue == null) return bValue == null ? 0 : 1;
            if (bValue == null) return -1;

            let comparison;
            if (typeof aValue === 'number' && typeof bValue === 'number') comparison = aValue - bValue;
            else comparison = String(aValue).localeCompare(String(bValue), undefined, { numeric: true, sensitivity: 'base' });
            return comparison * sampleSummarySort.direction;
        }

        function renderSampleSummaryTable() {
            const rows = [];
            let bulkCount = 0;
            let shelbyCount = 0;
            let sequence = 0;

            borings.forEach(boring => {
                (boring.samples || []).forEach(sample => {
                    const sampleType = String(sample.type || '').trim().toUpperCase();
                    if (sampleType === 'BULK') bulkCount++;
                    if (sampleType === 'ST') shelbyCount++;

                    const depth = getRemarksDepth(sample.whole, sample.dec);
                    const sampleLength = getSummaryNumber(sample.length);
                    const recovery = getSummaryNumber(sample.rec);
                    const nValue = computeN(sample.b2, sample.b3, sample.b1);
                    const boringId = String(boring.id || 'N/A');
                    const uscs = String(sample.uscs || '').trim().toUpperCase();
                    const sampleDate = String(sample.date || boring.startDate || '').trim();

                    rows.push({
                        sequence: sequence++,
                        boringId,
                        values: [
                            boringId,
                            depth == null ? '--' : `${depth.toFixed(1)} ft`,
                            uscs || '--',
                            sampleDate || '--',
                            sampleType || '--',
                            sampleLength == null ? '--' : `${sampleLength.toFixed(1)} in`,
                            recovery == null ? '--' : `${recovery.toFixed(1)} in`,
                            nValue === '' ? '--' : String(nValue)
                        ],
                        sort: {
                            boring: boringId,
                            depth,
                            uscs,
                            date: sampleDate,
                            type: sampleType,
                            length: sampleLength,
                            recovery,
                            nValue: nValue === 'Refusal' ? Number.POSITIVE_INFINITY : getSummaryNumber(nValue)
                        }
                    });
                });
            });

            const totalSampleCount = rows.length;
            const visibleRows = sampleSummaryTypeFilter === 'ALL'
                ? rows
                : rows.filter(item => item.sort.type === sampleSummaryTypeFilter);

            visibleRows.sort((a, b) => {
                const primary = compareSampleSummaryValues(a, b, sampleSummarySort.key);
                if (primary) return primary;
                const boringComparison = compareBoringIds(a.boringId, b.boringId);
                if (boringComparison) return boringComparison;
                return compareNullableNumbers(a.sort.depth, b.sort.depth) || a.sequence - b.sequence;
            });

            document.getElementById('sampleSummaryCounts').textContent = `Project totals: Bulk ${bulkCount} | Shelby tubes ${shelbyCount}`;
            document.getElementById('sampleSummaryVisibleCount').textContent = `Showing ${visibleRows.length} of ${totalSampleCount} samples`;
            const filter = document.getElementById('sampleSummaryTypeFilter');
            if (filter) filter.value = sampleSummaryTypeFilter;
            const tbody = document.getElementById('summarySamplesTbody');
            tbody.replaceChildren();
            if (rows.length === 0) {
                const row = document.createElement('tr');
                const cell = document.createElement('td');
                cell.colSpan = 8;
                cell.className = 'py-4 px-2 text-center text-slate-500';
                cell.textContent = 'No soil samples recorded.';
                row.appendChild(cell);
                tbody.appendChild(row);
            } else if (visibleRows.length === 0) {
                const row = document.createElement('tr');
                const cell = document.createElement('td');
                cell.colSpan = 8;
                cell.className = 'py-4 px-2 text-center text-slate-500';
                cell.textContent = 'No samples match this filter.';
                row.appendChild(cell);
                tbody.appendChild(row);
            } else {
                visibleRows.forEach(item => {
                    const row = document.createElement('tr');
                    row.className = 'hover:bg-slate-50 dark:hover:bg-slate-800/40';
                    item.values.forEach((value, index) => {
                        const cell = document.createElement('td');
                        cell.className = index === 0 || index === 2 || index === 4
                            ? 'py-2 px-2 font-semibold'
                            : 'py-2 px-2 text-right';
                        cell.textContent = value;
                        row.appendChild(cell);
                    });
                    tbody.appendChild(row);
                });
            }

            document.querySelectorAll('th[data-sample-sort]').forEach(header => {
                const isSorted = header.dataset.sampleSort === sampleSummarySort.key;
                header.setAttribute('aria-sort', isSorted
                    ? (sampleSummarySort.direction === 1 ? 'ascending' : 'descending')
                    : 'none');
                const indicator = header.querySelector('[data-sort-indicator]');
                if (indicator) indicator.textContent = isSorted
                    ? (sampleSummarySort.direction === 1 ? '^' : 'v')
                    : '-';
            });
        }

        function filterSampleSummaryByType(sampleType) {
            sampleSummaryTypeFilter = sampleType || 'ALL';
            renderSampleSummaryTable();
        }

        function sortSampleSummary(key) {
            if (sampleSummarySort.key === key) sampleSummarySort.direction *= -1;
            else sampleSummarySort = { key, direction: 1 };
            renderSampleSummaryTable();
        }

        function formatPieFootage(value) {
            return Number(value).toFixed(1);
        }

        function formatPiePercentage(value, total) {
            const percentage = total > 0 ? value / total * 100 : 0;
            if (value > 0 && percentage < 0.5) return '<1%';
            return `${Math.round(percentage)}%`;
        }

        function renderFootagePieLegend(containerId, items, total, colors) {
            const container = document.getElementById(containerId);
            container.replaceChildren();
            const legendItems = items.length ? items : [{ label: 'No Soil Data', value: 0 }];

            legendItems.forEach((item, index) => {
                const row = document.createElement('div');
                row.className = 'flex items-start gap-2 rounded px-1.5 py-1 text-[10px] hover:bg-slate-100 dark:hover:bg-slate-800';
                const swatch = document.createElement('span');
                swatch.className = 'mt-0.5 h-2.5 w-2.5 flex-shrink-0 rounded-sm';
                swatch.style.backgroundColor = colors[index] || '#94a3b8';
                const label = document.createElement('span');
                label.className = 'min-w-0 flex-1 break-words font-semibold text-slate-700 dark:text-slate-200';
                label.textContent = item.label;
                const value = document.createElement('span');
                value.className = 'flex-shrink-0 text-right text-slate-500 dark:text-slate-400';
                value.textContent = `${formatPieFootage(item.value)} ft | ${formatPiePercentage(item.value, total)}`;
                row.append(swatch, label, value);
                container.appendChild(row);
            });
        }

        function renderUSCSPieChart(uscsMap) {
            const ctx = document.getElementById('uscsPieChart').getContext('2d');
            if (uscsChartInstance) uscsChartInstance.destroy();
            const items = Object.entries(uscsMap)
                .filter(([, footage]) => Number.isFinite(footage))
                .map(([label, footage]) => ({ label, value: footage }));
            const total = items.reduce((sum, item) => sum + item.value, 0);
            const hasFootage = items.some(item => item.value > 0);
            const labels = hasFootage ? items.map(item => item.label) : ['No Soil Data'];
            const data = hasFootage ? items.map(item => item.value) : [1];
            const colors = labels.map((_, index) => `hsl(${Math.round(index * 360 / Math.max(labels.length, 1))} 68% 52%)`);
            renderFootagePieLegend('uscsPieLegend', hasFootage ? items : [], total, colors);

            uscsChartInstance = new Chart(ctx, {
                type: 'pie',
                data: {
                    labels: labels,
                    datasets: [{ data: data, backgroundColor: colors }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: context => {
                                    if (!hasFootage) return 'No soil footage recorded';
                                    const item = items[context.dataIndex];
                                    return `${item.label}: ${formatPieFootage(item.value)} ft (${formatPiePercentage(item.value, total)} of footage)`;
                                }
                            }
                        }
                    }
                },
            });
        }

        function renderSoilRockPieChart(soilFt, rockFt) {
            const ctx = document.getElementById('soilRockPieChart').getContext('2d');
            if (soilRockChartInstance) soilRockChartInstance.destroy();
            const items = [
                { label: 'Soil Drilling', value: soilFt },
                { label: 'Rock Coring', value: rockFt }
            ];
            const total = soilFt + rockFt;
            const colors = ['#f59e0b', '#475569'];
            renderFootagePieLegend('soilRockPieLegend', items, total, colors);

            soilRockChartInstance = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: items.map(item => item.label),
                    datasets: [{ data: items.map(item => item.value), backgroundColor: colors }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: context => {
                                    const item = items[context.dataIndex];
                                    return `${item.label}: ${formatPieFootage(item.value)} ft (${formatPiePercentage(item.value, total)} of footage)`;
                                }
                            }
                        }
                    }
                },
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
                version: "v1.7.0",
                exportTimestamp: new Date().toISOString(),
                projectMeta: projectMeta,
                borings: borings
            };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const dlAnchor = document.createElement('a');
            dlAnchor.href = url;
            dlAnchor.download = buildExportFilename("txt");
            document.body.appendChild(dlAnchor);
            dlAnchor.click();
            dlAnchor.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);

            markSavedNow();
            showToast("Project saved (backup exported as .txt).");
        }

        function formatRockAnomaliesForExcel(anomalies) {
            if (!Array.isArray(anomalies)) return "";
            return anomalies.filter(anomaly => anomaly && typeof anomaly === 'object').map(anomaly => {
                const top = Number(anomaly.topDepth);
                const length = Number(anomaly.length);
                const bottom = top + length;
                const rawLengthInches = String(anomaly.lengthInches == null ? '' : anomaly.lengthInches).trim();
                const lengthInches = rawLengthInches ? Number(rawLengthInches) : NaN;
                const displayedInches = Number.isFinite(lengthInches) ? lengthInches : length * 12;
                const topText = Number.isFinite(top) ? `${top.toFixed(2)} ft` : String(anomaly.topDepth || "");
                const lengthText = Number.isFinite(length) ? `${length.toFixed(2)} ft (${Number(displayedInches.toFixed(2))} in)` : String(anomaly.length || "");
                const bottomText = Number.isFinite(bottom) ? `${bottom.toFixed(2)} ft` : "";
                const remarkText = String(anomaly.otherRemark || "").trim();
                return `${anomaly.type || "Anomaly"} | Top: ${topText} | Length: ${lengthText} | Bottom: ${bottomText}${remarkText ? ` | Remark: ${remarkText}` : ""}`;
            }).join("\n");
        }

        async function shareProjectJSON() {
            const payload = {
                application: "StrataScribe",
                version: "v1.7.0",
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

        function isImportObject(value) {
            return value !== null && typeof value === "object" && !Array.isArray(value);
        }

        function normalizeImportedText(value, fallback) {
            if (value === undefined || value === null) return fallback;
            if (typeof value !== "string" && typeof value !== "number") return null;
            return String(value);
        }

        function normalizeImportedTextArray(value) {
            if (value === undefined || value === null) return [];
            if (typeof value === "string") return value.trim() ? [value] : [];
            if (!Array.isArray(value)) return null;
            const result = [];
            for (const item of value) {
                if (typeof item !== "string" && typeof item !== "number") return null;
                result.push(String(item));
            }
            return result;
        }

        function normalizeImportedRecords(records, defaults, textFields, arrayFields, multiFields, requireDepth) {
            if (records === undefined || records === null) return [];
            if (!Array.isArray(records)) return null;

            const normalizedRecords = [];
            for (const record of records) {
                if (!isImportObject(record)) return null;
                const normalized = { ...defaults, ...record };

                if (requireDepth) {
                    const whole = normalizeImportedText(record.whole, null);
                    const decimal = normalizeImportedText(record.dec, defaults.dec);
                    if (whole === null || whole.trim() === "" || !Number.isFinite(Number(whole)) ||
                        decimal === null || decimal.trim() === "" || !Number.isFinite(Number(decimal))) return null;
                    normalized.whole = whole;
                    normalized.dec = decimal;
                }

                for (const field of textFields) {
                    normalized[field] = normalizeImportedText(record[field], defaults[field]);
                    if (normalized[field] === null) return null;
                }
                for (const field of arrayFields) {
                    normalized[field] = normalizeImportedTextArray(record[field]);
                    if (normalized[field] === null) return null;
                }
                for (const field of multiFields) {
                    const value = record[field];
                    if (value !== undefined && value !== null && !Array.isArray(value) && typeof value !== "string") return null;
                    normalized[field] = normalizeMultiRockValues(value);
                }
                normalizedRecords.push(normalized);
            }
            return normalizedRecords;
        }

        function normalizeImportedProject(parsed) {
            if (!isImportObject(parsed) || !isImportObject(parsed.projectMeta) ||
                !Array.isArray(parsed.borings) || parsed.borings.length === 0) return null;

            const projectMeta = { ...parsed.projectMeta };
            for (const field of ["client", "name", "number"]) {
                projectMeta[field] = normalizeImportedText(projectMeta[field], "");
                if (projectMeta[field] === null) return null;
            }

            const boringDefaults = {
                rig: "", driller: "", logger: "", additionalNotes: "",
                gpsLat: "", gpsLon: "", gpsAccuracy: "", gpsElevation: "", gpsTimestamp: "", gpsSource: "", gpsLocked: false,
                totalDepth: "0.0", offset: "0", direction: "N/A", startDate: "", endDate: "",
                terminationReason: "Completed at Planned Depth", refusalType: "None", refusalDepth: ""
            };
            const surfaceDefaults = { thickness: "", type: "Asphalt", remarks: "" };
            const sampleDefaults = {
                whole: 0, dec: "0.0", type: "SS", length: "18\"", b1: "", b2: "", b3: "", rec: "",
                uscs: "", gradation: "", major: "", minor: "", moisture: "", shade: "", colors: [], pocketPen: "",
                origin: "", mottling: "", descriptors: [], remarks: ""
            };
            const rockDefaults = {
                whole: 0, dec: "0.0", runLength: "5.0", recWhole: 0, recFrac: "0/8", recovery: "",
                rqdWhole: 0, rqdFrac: "0/8", rqd: "", rockType: "", shade: "", colors: [], weathering: [],
                grainSize: [], grainShape: [], strength: [], bedding: [], jointType: "", jointSpacing: "",
                jointPersistence: "", jointRoughness: "", jointGeometry: "", jointAperture: "", jointFilling: "",
                gwCondition: "", natFractures: "0", descriptors: [], remarks: "", anomalies: []
            };
            const groundwaterDefaults = { depth: "", time: "N/A", customTime: "" };
            const boringIds = new Set();
            const normalizedBorings = [];

            for (const boring of parsed.borings) {
                if (!isImportObject(boring)) return null;
                const id = normalizeImportedText(boring.id, "");
                if (id === null || id.trim() === "") return null;
                const normalizedId = id.trim().toLowerCase();
                if (boringIds.has(normalizedId)) return null;
                boringIds.add(normalizedId);

                const normalized = { ...boringDefaults, ...boring, id: id.trim() };
                const boringTextFields = [
                    "rig", "driller", "logger", "additionalNotes", "gpsLat", "gpsLon", "gpsAccuracy",
                    "gpsElevation", "gpsTimestamp", "gpsSource", "totalDepth", "offset", "direction",
                    "startDate", "endDate", "terminationReason", "refusalType", "refusalDepth"
                ];
                for (const field of boringTextFields) {
                    normalized[field] = normalizeImportedText(boring[field], boringDefaults[field]);
                    if (normalized[field] === null) return null;
                }
                if (boring.gpsLocked !== undefined && boring.gpsLocked !== null && typeof boring.gpsLocked !== "boolean") return null;
                normalized.gpsLocked = boring.gpsLocked === undefined || boring.gpsLocked === null ? false : boring.gpsLocked;

                normalized.methods = normalizeImportedTextArray(boring.methods);
                normalized.surfaceConditions = normalizeImportedRecords(
                    boring.surfaceConditions, surfaceDefaults, ["thickness", "type", "remarks"], [], [], false
                );
                normalized.samples = normalizeImportedRecords(
                    boring.samples, sampleDefaults,
                    ["type", "length", "b1", "b2", "b3", "rec", "uscs", "gradation", "major", "minor", "moisture", "shade", "origin", "mottling", "remarks", "pocketPen"],
                    ["colors", "descriptors"], [], true
                );
                if (normalized.samples) {
                    normalized.samples = normalized.samples.map(sample => {
                        const rawPocketPen = String(sample.pocketPen == null ? "" : sample.pocketPen).trim();
                        if (!rawPocketPen) return sample;
                        const pocketPen = Number(rawPocketPen);
                        return Number.isFinite(pocketPen) && pocketPen >= 0 && pocketPen <= 4.5 &&
                            Math.abs(pocketPen * 4 - Math.round(pocketPen * 4)) < 1e-9
                            ? { ...sample, pocketPen: pocketPen.toFixed(2) }
                            : null;
                    });
                    if (normalized.samples.some(sample => sample === null)) return null;
                }
                normalized.rockSamples = normalizeImportedRecords(
                    boring.rockSamples, rockDefaults,
                    ["runLength", "recWhole", "recFrac", "recovery", "rqdWhole", "rqdFrac", "rqd", "rockType", "shade", "jointType", "jointSpacing", "jointPersistence", "jointRoughness", "jointGeometry", "jointAperture", "jointFilling", "gwCondition", "natFractures", "remarks"],
                    ["colors", "descriptors"], ["weathering", "grainSize", "grainShape", "strength", "bedding"], true
                );
                if (normalized.rockSamples) {
                    normalized.rockSamples = normalized.rockSamples.map(run => {
                        const anomalies = normalizeImportedRockAnomalies(run.anomalies, run);
                        return anomalies === null ? null : { ...run, anomalies };
                    });
                    if (normalized.rockSamples.some(run => run === null)) return null;
                }
                normalized.gw = normalizeImportedRecords(
                    boring.gw, groundwaterDefaults, ["depth", "time", "customTime"], [], [], false
                );
                if (normalized.methods === null || normalized.surfaceConditions === null ||
                    normalized.samples === null || normalized.rockSamples === null || normalized.gw === null) return null;
                while (normalized.gw.length < 3) normalized.gw.push({ ...groundwaterDefaults });
                normalizedBorings.push(normalized);
            }

            return { projectMeta, borings: normalizedBorings };
        }

        function normalizeImportedRockAnomalies(anomalies, run) {
            if (!Array.isArray(anomalies)) return null;
            const runTop = getRemarksDepth(run.whole, run.dec);
            const runLength = Number.parseFloat(run.runLength);
            const runBottom = runTop !== null && Number.isFinite(runLength) ? runTop + runLength : null;
            const normalized = [];
            for (const anomaly of anomalies) {
                if (!isImportObject(anomaly)) return null;
                const type = normalizeImportedText(anomaly.type, "");
                const topText = normalizeImportedText(anomaly.topDepth, "");
                const lengthText = normalizeImportedText(anomaly.length, "");
                const lengthInchesText = normalizeImportedText(anomaly.lengthInches, "");
                const otherRemark = normalizeImportedText(anomaly.otherRemark, "");
                if (type === null || topText === null || lengthText === null || lengthInchesText === null || otherRemark === null ||
                    !rockAnomalyTypes.includes(type)) return null;
                const top = Number(topText);
                const length = Number(lengthText);
                const lengthInches = lengthInchesText.trim() ? Number(lengthInchesText) : length * 12;
                const convertedLength = convertRockAnomalyInchesToFeet(lengthInches);
                if (!topText.trim() || !lengthText.trim() || !Number.isFinite(top) || !Number.isFinite(length) || length <= 0 ||
                    !Number.isFinite(lengthInches) || lengthInches <= 0 || convertedLength === null ||
                    Math.abs(convertedLength - length) > 1e-9 ||
                    runTop === null || runBottom === null || top < runTop - 1e-9 || top + length > runBottom + 1e-9) return null;
                normalized.push({
                    type,
                    topDepth: topText,
                    length: convertedLength.toFixed(2),
                    lengthInches: lengthInchesText.trim() ? lengthInchesText : lengthInches.toFixed(2),
                    otherRemark
                });
            }
            return normalized;
        }

        function importJSON(event) {
            const file = event.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = function(e) {
                let importedProject;
                try {
                    const parsed = JSON.parse(e.target.result);
                    importedProject = normalizeImportedProject(parsed);
                } catch (err) {
                    importedProject = null;
                }
                if (!importedProject) {
                    alert("The selected file is not a valid StrataScribe project.");
                } else {
                    projectMeta = importedProject.projectMeta;
                    borings = importedProject.borings;
                    migrateLegacyGroundwaterObservationTypes();
                    activeBoringIndex = 0;
                    updateBoringSelector();
                    syncHeaderUI();
                    renderTables();
                    markSavedNow();
                    saveLocal();
                    showToast("Project successfully imported!");
                }
                event.target.value = "";
            };
            reader.readAsText(file);
        }

        function exportExcel() {
            if (typeof XLSX === 'undefined') {
                showToast("Excel export is unavailable. Check your internet connection and reload the app.");
                return;
            }

            const toExcelNumber = (value) => {
                if (value === "" || value === null || value === undefined) return "";
                if (typeof value === "number") return Number.isFinite(value) ? value : "";
                if (typeof value === "string" && value.trim() === "") return "";
                const number = Number(value);
                return Number.isFinite(number) ? number : value;
            };
            const getDepthFt = (whole, decimal) => {
                const wholeFeet = toExcelNumber(whole);
                const decimalFeet = toExcelNumber(decimal);
                if (!Number.isFinite(wholeFeet) || !Number.isFinite(decimalFeet)) return "";
                return Number((wholeFeet + decimalFeet).toFixed(1));
            };

            const projectRows = [{
                ProjectNumber: projectMeta.number || "",
                ProjectName: projectMeta.name || "",
                Client: projectMeta.client || "",
                ExportDate: new Date().toISOString().slice(0, 10),
                StrataScribeVersion: "v1.7.0"
            }];
            const boringRows = borings.map(b => ({
                BoringID: b.id || "",
                Rig: b.rig || "",
                Driller: b.driller || "",
                FieldLogger: b.logger || "",
                TotalDepth: toExcelNumber(b.totalDepth),
                Offset: toExcelNumber(b.offset),
                Direction: b.direction || "",
                TerminationReason: b.terminationReason || "",
                RefusalType: b.refusalType || "",
                RefusalDepth: toExcelNumber(b.refusalDepth),
                Latitude: toExcelNumber(b.gpsLat),
                Longitude: toExcelNumber(b.gpsLon),
                GPSAccuracy: toExcelNumber(b.gpsAccuracy),
                Elevation: toExcelNumber(b.gpsElevation),
                GPSTimestamp: b.gpsTimestamp || "",
                GPSSource: b.gpsSource || "",
                GPSLocked: !!b.gpsLocked,
                DrillingMethods: Array.isArray(b.methods) ? b.methods.join(", ") : "",
                StartDate: b.startDate || "",
                EndDate: b.endDate || "",
                AdditionalNotes: b.additionalNotes || ""
            }));

            const surfaceConditionRows = [];
            const groundwaterRows = [];
            const soilSampleRows = [];
            const rockRunRows = [];
            borings.forEach(b => {
                (b.surfaceConditions || []).forEach((sc, index) => {
                    surfaceConditionRows.push({
                        BoringID: b.id || "",
                        Order: index + 1,
                        ThicknessIn: toExcelNumber(sc.thickness),
                        Type: sc.type || "",
                        Remarks: sc.remarks || ""
                    });
                });
                (b.gw || []).forEach((gw, index) => {
                    if (!gw) return;
                    const hasObservation = (gw.depth !== undefined && gw.depth !== null && String(gw.depth).trim() !== "") ||
                        (gw.time && gw.time !== "N/A") ||
                        (gw.customTime && String(gw.customTime).trim() !== "");
                    if (!hasObservation) return;
                    groundwaterRows.push({
                        BoringID: b.id || "",
                        ObservationNumber: index + 1,
                        DepthFt: toExcelNumber(gw.depth),
                        ObservationType: gw.time || "",
                        CustomTime: gw.customTime || ""
                    });
                });
                (b.samples || []).forEach(s => {
                    const nValue = computeN(s.b2, s.b3, s.b1);
                    const densityConsistency = computeConsistencyDensity(nValue, s.uscs);
                    soilSampleRows.push({
                        BoringID: b.id || "",
                        DepthFt: getDepthFt(s.whole, s.dec),
                        SampleType: s.type || "",
                        SampleLengthIn: s.length || "",
                        Blow1: toExcelNumber(s.b1),
                        Blow2: toExcelNumber(s.b2),
                        Blow3: toExcelNumber(s.b3),
                        NValue: nValue,
                        RecoveryIn: toExcelNumber(s.rec),
                        PocketPenTsf: toExcelNumber(s.pocketPen),
                        USCS: s.uscs || "",
                        Gradation: s.gradation || "",
                        MajorModifier: s.major || "",
                        MinorModifier: s.minor || "",
                        Moisture: s.moisture || "",
                        DensityConsistency: densityConsistency,
                        Origin: s.origin || "",
                        Shade: s.shade || "",
                        Colors: formatColorsString(s.colors),
                        Mottling: s.mottling || "",
                        Descriptors: Array.isArray(s.descriptors) ? s.descriptors.join(", ") : "",
                        AutoDescription: buildSoilDescription(s, { ...s, density: densityConsistency }),
                        Remarks: s.remarks || ""
                    });
                });
                (b.rockSamples || []).forEach(r => {
                    const topDepthFt = getDepthFt(r.whole, r.dec);
                    const runLengthFt = toExcelNumber(r.runLength);
                    const bottomDepthFt = Number.isFinite(topDepthFt) && Number.isFinite(runLengthFt)
                        ? Number((topDepthFt + runLengthFt).toFixed(1))
                        : "";
                    rockRunRows.push({
                        BoringID: b.id || "",
                        TopDepthFt: topDepthFt,
                        BottomDepthFt: bottomDepthFt,
                        RunLengthFt: runLengthFt,
                        RockType: r.rockType || "",
                        Shade: r.shade || "",
                        Weathering: formatMultiRockField(r.weathering),
                        GrainSize: formatMultiRockField(r.grainSize),
                        GrainShape: formatMultiRockField(r.grainShape),
                        Strength: formatMultiRockField(r.strength),
                        Bedding: formatMultiRockField(r.bedding),
                        JointType: r.jointType || "",
                        JointSpacing: r.jointSpacing || "",
                        JointPersistence: r.jointPersistence || "",
                        JointRoughness: r.jointRoughness || "",
                        JointGeometry: r.jointGeometry || "",
                        JointAperture: r.jointAperture || "",
                        JointFilling: r.jointFilling || "",
                        GroundwaterCondition: r.gwCondition || "",
                        NaturalFracturesPerFt: toExcelNumber(r.natFractures),
                        Descriptors: r.descriptors ? r.descriptors.join(", ") : "",
                        RecoveryFt: toExcelNumber(r.recovery),
                        RecoveryIn: formatInchesDisplayString(r.recWhole, r.recFrac),
                        RQDFt: toExcelNumber(r.rqd),
                        RQDIn: formatInchesDisplayString(r.rqdWhole, r.rqdFrac),
                        AutoDescription: buildRockDescription(r),
                        Anomalies: formatRockAnomaliesForExcel(r.anomalies),
                        Remarks: r.remarks || ""
                    });
                });
            });

            const byBoringAndDepth = (depthKey) => (a, b) => {
                const boringOrder = compareBoringIds(a.BoringID, b.BoringID);
                if (boringOrder !== 0) return boringOrder;
                const aDepth = typeof a[depthKey] === "number" ? a[depthKey] : Number.POSITIVE_INFINITY;
                const bDepth = typeof b[depthKey] === "number" ? b[depthKey] : Number.POSITIVE_INFINITY;
                return aDepth - bDepth;
            };
            soilSampleRows.sort(byBoringAndDepth("DepthFt"));
            rockRunRows.sort(byBoringAndDepth("TopDepthFt"));

            const sheets = [
                {
                    name: "Project",
                    headers: ["ProjectNumber", "ProjectName", "Client", "ExportDate", "StrataScribeVersion"],
                    rows: projectRows
                },
                {
                    name: "Borings",
                    headers: ["BoringID", "Rig", "Driller", "FieldLogger", "TotalDepth", "Offset", "Direction", "TerminationReason", "RefusalType", "RefusalDepth", "Latitude", "Longitude", "GPSAccuracy", "Elevation", "GPSTimestamp", "GPSSource", "GPSLocked", "DrillingMethods", "StartDate", "EndDate", "AdditionalNotes"],
                    rows: boringRows
                },
                {
                    name: "SurfaceConditions",
                    headers: ["BoringID", "Order", "ThicknessIn", "Type", "Remarks"],
                    rows: surfaceConditionRows
                },
                {
                    name: "Groundwater",
                    headers: ["BoringID", "ObservationNumber", "DepthFt", "ObservationType", "CustomTime"],
                    rows: groundwaterRows
                },
                {
                    name: "SoilSamples",
                    headers: ["BoringID", "DepthFt", "SampleType", "SampleLengthIn", "Blow1", "Blow2", "Blow3", "NValue", "RecoveryIn", "PocketPenTsf", "USCS", "Gradation", "MajorModifier", "MinorModifier", "Moisture", "DensityConsistency", "Origin", "Shade", "Colors", "Mottling", "Descriptors", "AutoDescription", "Remarks"],
                    rows: soilSampleRows
                },
                {
                    name: "RockRuns",
                    headers: ["BoringID", "TopDepthFt", "BottomDepthFt", "RunLengthFt", "RockType", "Shade", "Weathering", "GrainSize", "GrainShape", "Strength", "Bedding", "JointType", "JointSpacing", "JointPersistence", "JointRoughness", "JointGeometry", "JointAperture", "JointFilling", "GroundwaterCondition", "NaturalFracturesPerFt", "Descriptors", "RecoveryFt", "RecoveryIn", "RQDFt", "RQDIn", "AutoDescription", "Anomalies", "Remarks"],
                    rows: rockRunRows
                }
            ];
            const wb = XLSX.utils.book_new();
            sheets.forEach(({ name, headers, rows }) => {
                const worksheet = XLSX.utils.json_to_sheet(rows, { header: headers });
                if (rows.length === 0) XLSX.utils.sheet_add_aoa(worksheet, [headers], { origin: "A1" });
                worksheet['!cols'] = headers.map(header => {
                    const maxLength = rows.reduce((max, row) => {
                        const value = row[header];
                        return Math.max(max, value === null || value === undefined ? 0 : String(value).length);
                    }, header.length);
                    return { wch: Math.min(Math.max(maxLength + 2, 10), 40) };
                });
                XLSX.utils.book_append_sheet(wb, worksheet, name);
            });

            XLSX.writeFile(wb, buildExportFilename("xlsx"));
            showToast("Excel workbook exported successfully.");
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