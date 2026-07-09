@echo off
echo Starting Wavelength local dev server...
echo.
echo Open TWO browser tabs at: http://localhost:3000
echo (Two tabs = two users, lets you test the full chat flow)
echo.
echo Press Ctrl+C to stop.
echo.
cd /d "%~dp0"
npx serve . --listen 8080 --no-clipboard
