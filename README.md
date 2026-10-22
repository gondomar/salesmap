# SalesMap

A phone-friendly map for door-to-door sprinkler blowout sales. Tap a house and mark it as
**Client**, **Callback**, **Not home**, **Refused**, or **No soliciting**. Pins sync to the cloud,
keep working with weak signal, and can be exported to a spreadsheet.

It's a free website (GitHub Pages) that you add to your phone's home screen, so it opens like
an app without going through the App Store.

---

## 1. Google Maps API key (about 10 min)

1. Go to https://console.cloud.google.com and create a project (e.g. "SalesMap").
2. Set up billing for it (**Billing** in the menu). Google needs a card on file, but the free
   monthly allowance covers a one-person door-knocking business.
3. **APIs & Services > Library**: enable **Maps JavaScript API** and **Geocoding API**.
4. **APIs & Services > Credentials > Create credentials > API key**. Copy the key.
5. Click the key to edit it:
   - **Application restrictions**: *Websites*. Add `http://localhost:8000/*` and
     `https://YOUR-GITHUB-USERNAME.github.io/*`
   - **API restrictions**: limit it to Maps JavaScript API and Geocoding API.
6. Optional but recommended: under **Billing > Budgets & alerts**, add a $1 budget alert.
7. Paste the key into `config.js` as `GOOGLE_MAPS_API_KEY`.

## 2. Firebase for cloud sync and login (about 10 min)

1. Go to https://console.firebase.google.com, click **Add project**, and choose the same
   Google Cloud project you created above.
2. On the project overview page, click the **Web** icon (`</>`) to add a web app. Copy the
   `firebaseConfig` object it shows into `config.js` as `FIREBASE_CONFIG`, like this:
   ```js
   export const FIREBASE_CONFIG = {
     apiKey: "...",
     authDomain: "...",
     projectId: "...",
     storageBucket: "...",
     messagingSenderId: "...",
     appId: "..."
   };
   ```
3. **Build > Authentication > Get started**: enable **Email/Password**. Then on the **Users**
   tab, click **Add user** and create your login.
4. In **Authentication > Settings > Authorized domains**, add `YOUR-GITHUB-USERNAME.github.io`.
5. **Build > Firestore Database > Create database**: pick a location near you and choose
   *production mode*.
6. On the Firestore **Rules** tab, paste the contents of `firestore.rules` and click
   **Publish**. Change `tylerlrose@gmail.com` in it (and `APP_ADMIN` in `app.js`) if a
   different person should be the app admin.

## Businesses and teams

Each business has its own pins and its own team. People only ever see their own business.

- **App admin** (`APP_ADMIN` in `app.js` and `firestore.rules`): the only person who can create
  businesses (**☰ > Team > Create another business**). They can't see other businesses' pins.
- **Owners**: add and remove people on their team (**☰ > Team**).
- **Members**: see and edit their business's pins.

New people tap **Create account** with the email an owner added, then confirm their email.
Each email can belong to one business.

If you leave `FIREBASE_CONFIG` as `null`, the app runs in local mode: pins are saved only in
that browser, with no login.

## 3. Try it on your computer

```bash
python3 -m http.server 8000
```
Then open http://localhost:8000.

## 4. Put it online for free (GitHub Pages)

```bash
git init && git add . && git commit -m "SalesMap"
gh repo create salesmap --public --source=. --push
```
On GitHub, open the repo, go to **Settings > Pages**, set *Source: Deploy from a branch*,
choose branch `main` and folder `/ (root)`, then click **Save**. After about a minute the app
is live at `https://YOUR-GITHUB-USERNAME.github.io/salesmap/`.

The keys in `config.js` are designed to be public. The Maps key only works on your website,
and only a business's team can read or change its pins (enforced by `firestore.rules`). Your customer
data lives in Firebase, not in the repo.

## 5. Install it on your phone

- **iPhone**: open the URL in **Safari**, tap **Share**, then **Add to Home Screen**.
- **Android**: open the URL in **Chrome**, tap the **⋮** menu, then **Install app** (or **Add to Home screen**).

Allow location access when asked so the blue dot shows where you are.

## Using it

- Tap a house to drop a pin. The address fills in automatically. Tap a status to save it.
- Tap an existing pin to change its status. Each tap logs a knock, so you can see "Not home · 3 knocks".
- Open **Name, phone & notes** to record details such as a quoted price or best time to call back.
- Tap the arrow button (bottom right) to jump back to where you are.
- Use **☰ > Find an address** to jump to an address, then tap the house inside the yellow circle.
- Use **☰ > Export to spreadsheet** to download a CSV that opens in Excel or Google Sheets. Use
  the Status column to filter, e.g. just clients.
- **☰ > Add someone to the app** has step-by-step instructions for giving someone access.
- **☰ > Toggle satellite / map** switches between aerial and street views.
