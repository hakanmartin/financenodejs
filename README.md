# Finans Takip Node.js Arka Uç

Bu depo, Node.js ve PostgreSQL ile oluşturulmuş Finans arka uç (backend) hizmetini içerir. Tam yığıt bir test ortamı için şu sıra ile servisleri başlatın: Docker Compose (PostgreSQL) > financenodejs (mevcut depo) > financefront (Nextjs) .
Dilerseniz tüm klasörleri birleştirip tek bir docker komutu ile daha kolay başlatabilirsiniz (bağımsız test senaryoları için mevcut şekilde devam edin).

## Gereksinimler

* Docker
* Node.js (>=18)
* npm

## Kurulum

### 1. Docker ile PostgreSQL'i Başlatma

Bu proje, boş bir PostgreSQL veritabanı oluşturan bir `docker-compose.yaml` dosyası içerir.

```bash
docker compose up -d
```

Bu, PostgreSQL'i arka planda başlatacaktır.

---

### 2. Ortam Değişkenlerini Yapılandırma

Kök dizinde bir `.env` dosyası oluşturun ve :

```env
DB_HOST=localhost
DB_PORT=5432
DB_USER=myuser
DB_PASSWORD=mypassword
DB_NAME=mydatabase
PORT=3030

AUDIENCE=
ISSUER_BASE_URL=
```

Auth0 yapılandırmanıza göre değerleri doldurun. Eğer veritabanı konfigurasyonları değiştirildiyse bu dosyada da güncelleyin. Audience, arka uç servisi için Auth0 da oluşturacağınız yapay bir domain, Issiuer Base Url ise Auth0 da oluşturduğunuz ön uç uygulamasının domain adresi.

---

### 3. Bağımlılıkları Yükleme

```bash
npm install
```

---

### 4. Arka Uç Çalıştırma

```bash
npm run dev
```

Arka uç geliştirme modunda başlayacaktır. localhost:3030 adresinde test edilebilir.

---

## Sonraki Adım

Arka uç başlatıldıktan sonra, ön uç uygulamasını çalıştırın:

Ön uç deposuna bakın:
[Finans Ön Ucu](https://github.com/hakanmartin/financefront)

---

## Proje Yapısı

```
.

├── docker-compose.yaml
├── .env
├── src
└── package.json
```

---
