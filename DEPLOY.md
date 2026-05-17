# Деплой на mafia.patgen.ru (Ubuntu/Debian)

Архитектура prod-стека:

```
Internet ──HTTPS:443──► host-nginx (TLS, Let's Encrypt)
                              │
                              ▼  HTTP
                       127.0.0.1:8080 (docker frontend nginx)
                          │     │
                          │     └─ /api, /ws ─► backend:8000 (docker, internal)
                          │                          │
                          │                          ▼
                          │                       db:5432 (docker, internal)
                          ▼
                       /, /static, *.{js,css}
                       (статика SPA)
```

Особенности:
- **Postgres не торчит наружу** (нет `ports` в compose)
- **Backend не торчит наружу** (только через docker network)
- **Frontend слушает 127.0.0.1:8080** — host-nginx проксирует и терминирует TLS
- **Один воркер uvicorn** (game-state в памяти процесса; multi-worker нужен Redis)
- **Backend — не root**, healthcheck'и на всех сервисах, лимиты на логи

---

## Подготовка сервера (один раз)

### 1. Зависимости

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin nginx certbot python3-certbot-nginx git
sudo systemctl enable --now docker
sudo usermod -aG docker $USER     # перелогиньтесь после
```

### 2. DNS

В панели patgen.ru добавьте A-запись:
```
mafia.patgen.ru   A   <IP вашего сервера>
```
Дождитесь пропагации (`dig mafia.patgen.ru` или `nslookup`).

### 3. Клонирование репозитория

```bash
sudo mkdir -p /srv
sudo chown $USER:$USER /srv
cd /srv
git clone <url-репозитория> ai-gamemaster
cd ai-gamemaster
```

---

## Конфигурация

### 1. Создаём `.env.prod`

```bash
cp .env.prod.example .env.prod

# Сгенерируйте секреты
SECRET_KEY=$(openssl rand -hex 32)
DB_PASS=$(openssl rand -base64 24)

# Подставьте их в .env.prod
sed -i "s|REPLACE_ME_WITH_OPENSSL_RAND_HEX_32|$SECRET_KEY|" .env.prod
sed -i "s|REPLACE_ME_STRONG_PASSWORD|$DB_PASS|" .env.prod

# Проверьте остальные значения
nano .env.prod
```

Убедитесь что:
- `REACT_APP_API_BASE_URL=https://mafia.patgen.ru`
- `REACT_APP_WS_BASE_URL=wss://mafia.patgen.ru`
- `CORS_ORIGINS=https://mafia.patgen.ru`

### 2. Host-nginx + map для WebSocket upgrade

В `/etc/nginx/nginx.conf` внутри блока `http { ... }` (если ещё нет) добавьте:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

Скопируйте конфиг сайта:

```bash
sudo cp nginx/mafia.patgen.ru.conf /etc/nginx/sites-available/mafia.patgen.ru.conf
sudo ln -s /etc/nginx/sites-available/mafia.patgen.ru.conf /etc/nginx/sites-enabled/
sudo nginx -t                # проверка синтаксиса
sudo systemctl reload nginx
```

### 3. TLS-сертификат через Let's Encrypt

```bash
sudo certbot --nginx -d mafia.patgen.ru --redirect --email your@email.com --agree-tos
```

Certbot допишет `ssl_certificate` / `listen 443 ssl` строки в конфиг и настроит автообновление (`/etc/cron.d/certbot` или `systemd timer`). Проверьте:

```bash
sudo certbot renew --dry-run
```

---

## Запуск стека

```bash
cd /srv/ai-gamemaster
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

Что произойдёт:
1. Соберутся образы `backend` (Dockerfile.prod) и `frontend` (Dockerfile.prod, статика → nginx).
2. Поднимется `db` (postgres) — данные в named volume `gamemaster_postgres_data_prod`.
3. `backend` дождётся healthy db, применит alembic-миграции, запустит uvicorn.
4. `frontend` (nginx) отдаст статику и проксирует `/api` + `/ws` на backend.
5. Frontend опубликован на `127.0.0.1:8080` — host-nginx проксирует с HTTPS.

Проверка:

```bash
docker compose -f docker-compose.prod.yml ps               # все healthy
curl -I https://mafia.patgen.ru/                            # 200 OK
curl https://mafia.patgen.ru/api/auth/me -i                 # 401 (без auth — норм)
docker compose -f docker-compose.prod.yml logs backend -f   # логи бэка
```

---

## Обновление

```bash
cd /srv/ai-gamemaster
git pull
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

Миграции применятся автоматически в `entrypoint.sh`.

## Откат миграции (если что-то пошло не так)

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod exec backend uv run alembic downgrade -1
```

## Бэкап базы

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod exec db \
    pg_dump -U gamemaster gamemaster > backup_$(date +%F).sql
```

Восстановление:

```bash
cat backup_2026-05-06.sql | docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T db \
    psql -U gamemaster -d gamemaster
```

---

## Что осталось НЕ настроено (на ваше усмотрение)

- **Firewall**: рекомендую `ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw enable`
- **Мониторинг**: ничего, кроме docker logs. Можно прикрутить Prometheus / loki, но проект небольшой.
- **Бэкапы**: делайте `pg_dump` раз в сутки (cron) и складывайте в S3/яндекс.диск.
- **CI/CD**: текущий процесс — `git pull && docker compose up -d --build`. GitHub Actions можно добавить позже.
- **logs-frontend**: исключён из прод-стека (требует docker.sock и без auth — security risk).

---

## Быстрая проверка готовности

После запуска прогоните чеклист:

- [ ] `https://mafia.patgen.ru` открывает SPA
- [ ] DevTools → Network: `/api/*` идут на тот же домен (не на localhost!)
- [ ] WebSocket в DevTools показывает `wss://mafia.patgen.ru/ws/...`
- [ ] `docker compose -f docker-compose.prod.yml ps` — все 3 контейнера `Up (healthy)`
- [ ] `docker compose -f docker-compose.prod.yml logs backend` — нет `ERROR` / traceback
- [ ] Регистрация и логин работают
- [ ] `nmap mafia.patgen.ru` снаружи: открыты только 80/443
