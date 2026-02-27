# 🎮 Secret Hitler Online

Gra multiplayer online — bez kompilacji natywnej, działa na Windows/Mac/Linux.

## 🚀 Uruchomienie (3 kroki)

```bash
npm install
npm start
# Otwórz: http://localhost:3000
```

**Domyślny admin:** `admin` / `admin123`

## Technologie (wszystkie pure JavaScript — brak Visual Studio!)
- **Express + Socket.io** — serwer i real-time
- **@seald-io/nedb** — baza danych (pliki .db w folderze /data)
- **session-file-store** — sesje w plikach
- **bcryptjs** — hashowanie haseł

## Funkcje
- ✅ Rejestracja + logowanie (admin aktywuje konta)
- ✅ Panel admina (aktywacja, uprawnienia, usuwanie)
- ✅ Pokoje gry z lobby (5-10 graczy)
- ✅ Chat globalny + per-pokój w czasie rzeczywistym
- ✅ Pełna logika Secret Hitler (wszystkie zasady, moce, VETO)
- ✅ Reconnect podczas gry

## Wdrożenie na Railway / Render
1. Wrzuć na GitHub
2. Połącz z railway.app lub render.com
3. Ustaw zmienną środowiskową: `SESSION_SECRET=twój-sekret`
