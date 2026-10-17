# JustShare Mobile (React Native + Expo)

Cross-platform mobile client for JustShare supporting Android and iOS.

## Prerequisites

- Node.js >= 18
- npm
- **Physical Android Phone**: Connected to the same Wi-Fi / Local Area Network (LAN) as your development PC, running the Expo Go app or an Expo Development Build.
- **Physical iPhone** (optional): Connected to the same Wi-Fi network.

---

## Physical Android Phone Setup & LAN Connection Guide

When running on a physical phone, `localhost` refers to the mobile phone itself, **not** your development PC. To connect your phone to the FastAPI backend running on your PC:

### Step 1: Find your PC's Local IP Address
On your development machine (Windows PowerShell):
```powershell
ipconfig
```
Look for your active network adapter (e.g., `Wireless LAN adapter Wi-Fi` or `Ethernet adapter`). Note the **IPv4 Address** (e.g., `192.168.1.50`).

### Step 2: Configure Environment Variables in Mobile
Create a `.env` file in the `mobile/` directory:
```bash
# Copy example
copy .env.example .env
```
Edit `mobile/.env` and replace `localhost` with your PC's IPv4 address:
```env
EXPO_PUBLIC_BACKEND_URL=http://192.168.1.50:8000
```
> **Note**: Do not include a trailing slash. Expo will automatically bundle variables prefixed with `EXPO_PUBLIC_` into the mobile app.

### Step 3: Run FastAPI Bound to All Network Interfaces
Ensure the FastAPI backend listens on `0.0.0.0` (all interfaces) rather than `127.0.0.1`:
```powershell
cd D:\JustShare\backend
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

### Step 4: Configure Windows Firewall
Ensure Windows Firewall permits incoming TCP traffic on port 8000:
1. Open PowerShell as Administrator.
2. Run:
   ```powershell
   New-NetFirewallRule -DisplayName "JustShare Backend Port 8000" -Direction Inbound -LocalPort 8000 -Protocol TCP -Action Allow
   ```
3. Alternatively, test connectivity from your phone's browser by opening `http://192.168.1.50:8000/docs`.

### Step 5: Start Expo Dev Server
```powershell
cd D:\JustShare\mobile
npm run start
```
Scan the displayed QR code with the Expo Go app or your camera on Android.

---

## Device Identity & Registration Flow

1. **Identity Generation**: Automatically creates a friendly display name (e.g. `Swift Falcon 42`).
2. **Backend Registration**: Issues `POST /api/v1/devices` to receive a `device_id` and a 24-hour signed JWT auth token.
3. **Secure Vault**: Credentials (`device_id`, `displayName`, `token`, `savedAt`) are securely stored in device keychain / keystore via `expo-secure-store`.
4. **Token Reuse & Validation**: On app launch, existing stored credentials are checked for JWT expiration (with a 60-second safety margin). If still valid, registration is skipped to prevent orphan server records.
5. **Deduplication**: In-flight registration requests are deduplicated to avoid duplicate calls during rapid UI re-renders or concurrent lifecycle hooks.

---

## Commands

- **Typecheck**:
  ```bash
  npm run typecheck
  ```
- **Start Dev Server**:
  ```bash
  npm run start
  ```
- **Android Native Run**:
  ```bash
  npm run android
  ```
- **iOS Native Run**:
  ```bash
  npm run ios
  ```
