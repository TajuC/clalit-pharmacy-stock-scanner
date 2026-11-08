# Pharmacy Stock Automation (Clalit)

## English

### Overview
This project scans medicine availability from the Clalit pharmacy stock service:
- Source: https://e-services.clalit.co.il/PharmacyStock/
- Scans one medicine across every locality that has a Clalit pharmacy
- Exports results to JSON and CSV (CSV opens correctly in Excel, Hebrew included)
- Provides a local dashboard for filtering and viewing results

### How it works
The stock service verifies every stock request with Google reCAPTCHA Enterprise and rejects headless browsers. The scanner therefore starts your installed Chrome or Edge with a temporary profile (minimized by default), loads the official page so reCAPTCHA can run, and sends the stock requests from inside that page. The temporary profile is deleted when the scan ends.

The service also rejects requests when they arrive too quickly, so verified requests are paced (one every 1.5 seconds by default). When the service starts rejecting, the scanner pauses with an increasing cooldown instead of retrying immediately, and stops after 5 minutes without a single accepted request.

### City index
Only about one in six localities has a Clalit pharmacy. Every scan records, per city, how many pharmacies the service returned and the nearest pharmacy distance from Ashkelon in `output/city-index.json`. Later scans:
- skip cities known to have no pharmacies (rechecked after 30 days, or always with `--full`)
- check cities that have pharmacies, plus any city not in the index yet
- start with the cities nearest Ashkelon

The first scan has to visit every locality, so it is the slow one. If it is stopped early, the next run continues where it left off.

### Requirements
- Node.js 20 or newer
- Google Chrome or Microsoft Edge (Windows, macOS, or a Linux desktop session). Set `BROWSER_PATH` to use another Chromium based browser.

### Quick Start
1. Install dependencies:

```bash
npm install
```

2. Run a scan:

```bash
npm run scan
```

3. Start the dashboard and open it in your browser:

```bash
npm run dashboard:open
```

On Windows PowerShell with a restricted execution policy, use `npm.cmd` instead of `npm`.

### Configuration
Set values in `.env` (see `.env.example`) or pass CLI flags:

| Setting | Flag | Default | Meaning |
|---|---|---|---|
| MEDICINE_QUERY | `--medicine` | required | Medicine query text, for example `VYVANSE 30MG` |
| APP_LANG | `--lang` | `he-il` | API language |
| CONCURRENCY | `--concurrency` | `2` | Parallel city checks |
| REQUEST_INTERVAL_MS | `--intervalMs` | `1500` | Minimum gap between verified requests |
| STALL_MINUTES | `--stallMinutes` | `5` | Stop when nothing is accepted for this long |
| MAX_CITIES | `--maxCities` | `0` | Limit cities per scan, `0` means no limit |
| INDEX_MAX_AGE_DAYS | `--indexMaxAgeDays` | `30` | Recheck cities without pharmacies after this many days |
| | `--full` | off | Ignore the city index and check every locality |
| | `--cityCode` | | Check one city by its code |
| TIMEOUT_MS | `--timeoutMs` | `25000` | Per request timeout |
| RETRIES | `--retries` | `2` | Retries per city on transient failures |
| SHOW_BROWSER | `--headed` | `false` | Show the browser window instead of minimizing it |
| SLOW_MO | `--slowMo` | `0` | Slow down browser automation (debugging) |
| BROWSER_PATH | `--browserPath` | auto | Browser executable to use |

### CLI Examples

```bash
node src/main.js --medicine "VYVANSE 30MG" --maxCities 100 --lang he-il
node src/main.js --cityCode 7100
node src/main.js --full
node src/dashboard.js --port 9090 --open
```

### Exit codes
- `0`: scan completed
- `1`: scan failed, no output written
- `2`: scan stopped early (for example the service kept rejecting requests); partial results were written and are marked as partial in the JSON and on the dashboard

### Output
Each scan writes:
- JSON summary with city level and pharmacy level rows
- CSV export for easy filtering and sorting

Important fields include:
- cityName, pharmacyName, pharmacyAddress, pharmacyPhone
- openingHours, isOpenNow
- distanceFromAshkelonKm, directionRelativeToAshkelon
- stockCode, availability

The JSON also carries `totals` (cities checked, skipped, failed, with results) and `partial` / `partialReason`.

### Stock Code Mapping
Based on kodStatusMlay:
- 30 -> in_stock
- 20 -> limited_stock
- 10 -> no_info
- 0 -> out_of_stock

---

## עברית

### תיאור הפרויקט
הפרויקט מבצע סריקה אוטומטית של זמינות תרופה בשירות מלאי בתי המרקחת של כללית:
- מקור: https://e-services.clalit.co.il/PharmacyStock/
- סריקה של תרופה אחת בכל היישובים שיש בהם בית מרקחת של כללית
- יצוא תוצאות לקבצי JSON ו-CSV (קובץ ה-CSV נפתח כראוי ב-Excel, כולל עברית)
- דשבורד מקומי להצגה, סינון ומיון תוצאות

### איך זה עובד
שירות המלאי מאמת כל בקשת מלאי באמצעות Google reCAPTCHA Enterprise ודוחה דפדפנים ללא ממשק (headless). לכן הסורק מפעיל את Chrome או Edge המותקנים במחשב עם פרופיל זמני (ממוזער כברירת מחדל), טוען את הדף הרשמי כדי ש-reCAPTCHA יפעל, ושולח את בקשות המלאי מתוך הדף. הפרופיל הזמני נמחק בסיום הסריקה.

השירות דוחה גם בקשות שמגיעות מהר מדי, ולכן הבקשות המאומתות נשלחות בקצב מבוקר (אחת לכל 1.5 שניות כברירת מחדל). כשהשירות מתחיל לדחות בקשות, הסורק עוצר להפסקה שמתארכת בהדרגה במקום לנסות שוב מיד, ומפסיק לגמרי אחרי 5 דקות בלי אף בקשה שהתקבלה.

### אינדקס יישובים
רק בכשישית מהיישובים יש בית מרקחת של כללית. כל סריקה שומרת בקובץ `output/city-index.json`, לכל יישוב, כמה בתי מרקחת השירות החזיר ומה המרחק של הקרוב שבהם מאשקלון. סריקות הבאות:
- מדלגות על יישובים שידוע שאין בהם בתי מרקחת (נבדקים שוב אחרי 30 יום, או תמיד עם `--full`)
- בודקות יישובים שיש בהם בתי מרקחת, וכל יישוב שעוד לא נמצא באינדקס
- מתחילות מהיישובים הקרובים ביותר לאשקלון

הסריקה הראשונה עוברת על כל היישובים ולכן היא האיטית. אם היא נעצרת באמצע, ההרצה הבאה ממשיכה מהנקודה שבה עצרה.

### דרישות
- Node.js בגרסה 20 ומעלה
- Google Chrome או Microsoft Edge (Windows, macOS או סביבת שולחן עבודה ב-Linux). אפשר להגדיר `BROWSER_PATH` כדי להשתמש בדפדפן אחר מבוסס Chromium.

### התחלה מהירה
1. התקנת תלויות:

```bash
npm install
```

2. הרצת סריקה:

```bash
npm run scan
```

3. הפעלת הדשבורד ופתיחה בדפדפן:

```bash
npm run dashboard:open
```

ב-Windows PowerShell עם מדיניות הרצה מוגבלת יש להשתמש ב-`npm.cmd` במקום `npm`.

### הגדרות
ניתן להגדיר בקובץ `.env` (ראו `.env.example`) או בפרמטרים ב-CLI:
- MEDICINE_QUERY (`--medicine`): שם התרופה לחיפוש, חובה
- APP_LANG (`--lang`): שפת ה-API, ברירת מחדל `he-il`
- CONCURRENCY (`--concurrency`): מספר יישובים שנבדקים במקביל, ברירת מחדל 2
- REQUEST_INTERVAL_MS (`--intervalMs`): מרווח מינימלי בין בקשות מאומתות, ברירת מחדל 1500
- STALL_MINUTES (`--stallMinutes`): עצירה אם אף בקשה לא התקבלה במשך זמן זה, ברירת מחדל 5
- MAX_CITIES (`--maxCities`): הגבלת מספר היישובים, 0 ללא הגבלה
- INDEX_MAX_AGE_DAYS (`--indexMaxAgeDays`): בדיקה חוזרת של יישובים ללא בתי מרקחת אחרי מספר ימים זה, ברירת מחדל 30
- `--full`: התעלמות מהאינדקס ובדיקת כל היישובים
- `--cityCode`: בדיקת יישוב בודד לפי קוד
- TIMEOUT_MS (`--timeoutMs`): זמן המתנה לכל בקשה
- RETRIES (`--retries`): מספר ניסיונות חוזרים במקרה תקלה זמנית
- SHOW_BROWSER (`--headed`): הצגת חלון הדפדפן במקום מזעור
- SLOW_MO (`--slowMo`): האטת האוטומציה לצורך דיבאג
- BROWSER_PATH (`--browserPath`): נתיב לדפדפן, מזוהה אוטומטית כברירת מחדל

### דוגמאות CLI

```bash
node src/main.js --medicine "VYVANSE 30MG" --maxCities 100 --lang he-il
node src/main.js --cityCode 7100
node src/main.js --full
node src/dashboard.js --port 9090 --open
```

### קודי יציאה
- `0`: הסריקה הושלמה
- `1`: הסריקה נכשלה ולא נכתב פלט
- `2`: הסריקה נעצרה מוקדם (למשל כשהשירות המשיך לדחות בקשות); תוצאות חלקיות נשמרו ומסומנות כחלקיות ב-JSON ובדשבורד

### פלט הסריקה
כל הרצה מייצרת:
- קובץ JSON עם תקציר ונתונים מפורטים
- קובץ CSV לסינון ומיון מהיר

שדות חשובים בפלט:
- cityName, pharmacyName, pharmacyAddress, pharmacyPhone
- openingHours, isOpenNow
- distanceFromAshkelonKm, directionRelativeToAshkelon
- stockCode, availability

### מיפוי קודי מלאי
לפי kodStatusMlay:
- 30 -> in_stock
- 20 -> limited_stock
- 10 -> no_info
- 0 -> out_of_stock
