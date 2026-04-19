# Pharmacy Stock Automation (Clalit)

## English

### Overview
This project scans medicine availability from the Clalit pharmacy stock service:
- Source: https://e-services.clalit.co.il/PharmacyStock/
- Scans one medicine across all available localities (cities / settlements)
- Exports results to JSON and CSV
- Provides a local dashboard for filtering and viewing results

### Features
- Fast API-based scanning with retries and concurrency control
- City-wide scan (or single-city scan by city code)
- Distance sorting from Ashkelon (hometown-first view)
- Dashboard filters by city and availability
- Opening/closing-hours extraction when available

### Quick Start (Windows)
1. Install dependencies:

```powershell
npm.cmd install
npx.cmd playwright install chromium
```

2. Run a full scan:

```powershell
npm.cmd run scan
```

3. Start dashboard:

```powershell
npm.cmd run dashboard
```

4. Open dashboard:

```powershell
Start-Process "http://localhost:8787"
```

### Configuration
Set values in .env (or pass CLI flags):
- MEDICINE_QUERY: medicine query text, for example VYVANSE 30MG
- APP_LANG: API language (default: he-il)
- CONCURRENCY: parallel city checks (default: 8)
- MAX_CITIES: 0 means all cities
- TIMEOUT_MS: per request timeout
- RETRIES: retry count for transient failures

### CLI Examples

```powershell
node src/main.js --medicine "VYVANSE 30MG" --concurrency 10 --maxCities 100 --lang he-il
node src/main.js --cityCode 7100
node src/dashboard.js --port 9090
```

### Output
Each scan writes:
- JSON summary with city-level and pharmacy-level rows
- CSV export for easy filtering/sorting

Important fields include:
- cityName, pharmacyName, pharmacyAddress, pharmacyPhone
- openingHours, isOpenNow
- distanceFromAshkelonKm, directionRelativeToAshkelon
- stockCode, availability

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
- סריקה של תרופה אחת בכל היישובים הזמינים (ערים/יישובים)
- יצוא תוצאות לקבצי JSON ו-CSV
- דשבורד מקומי להצגה, סינון ומיון תוצאות

### יכולות עיקריות
- סריקה מהירה דרך API עם מנגנון Retry ושליטה במקביליות
- סריקה ארצית מלאה או סריקה לפי קוד יישוב בודד
- מיון לפי מרחק מאשקלון (עיר בית)
- סינון בתצוגת הדשבורד לפי עיר וזמינות
- הצגת שעות פתיחה/סגירה כאשר המידע קיים

### התחלה מהירה (Windows)
1. התקנת תלויות:

```powershell
npm.cmd install
npx.cmd playwright install chromium
```

2. הרצת סריקה מלאה:

```powershell
npm.cmd run scan
```

3. הפעלת הדשבורד:

```powershell
npm.cmd run dashboard
```

4. פתיחה בדפדפן:

```powershell
Start-Process "http://localhost:8787"
```

### הגדרות
ניתן להגדיר בקובץ .env (או בפרמטרים ב-CLI):
- MEDICINE_QUERY: שם התרופה לחיפוש
- APP_LANG: שפת ה-API (ברירת מחדל: he-il)
- CONCURRENCY: מספר בקשות במקביל
- MAX_CITIES: אם 0 אז כל היישובים
- TIMEOUT_MS: זמן המתנה לכל בקשה
- RETRIES: מספר ניסיונות חוזרים במקרה תקלה זמנית

### דוגמאות CLI

```powershell
node src/main.js --medicine "VYVANSE 30MG" --concurrency 10 --maxCities 100 --lang he-il
node src/main.js --cityCode 7100
node src/dashboard.js --port 9090
```

### פלט הסריקה
כל הרצה מייצרת:
- קובץ JSON עם תקציר ונתונים מפורטים
- קובץ CSV לסינון/מיון מהיר

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
