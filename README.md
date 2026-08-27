# Beaumont Club — Gerçek Veritabanlı Yönetim Sistemi

Bu sürüm:
- SQLite gerçek veritabanı kullanır.
- Kullanıcı girişi + oturum yönetimi içerir.
- Stok, sipariş, müşteri, aylık özet, ekonomi, etkinlik, not, alacak-verecek ve takvim modüllerini içerir.
- Sipariş oluşturulunca stok otomatik düşer ve satış geliri otomatik finans kaydına yazılır.
- Sipariş silinince stok geri alınır ve otomatik gelir kaydı kaldırılır.
- Gerçek PDF raporu server tarafında PDFKit ile üretir.
- Günlük otomatik veritabanı yedeği alır.
- Responsive / mobile-first arayüze sahiptir.
- Chart.js ile grafikler içerir.
- Döviz ve hava durumu ana sayfada canlı API'den alınır.

## Kurulum

Node.js 20+ kurulu olmalı.

```bash
npm install
```

`.env.example` dosyasını `.env` olarak kopyalayın ve özellikle `SESSION_SECRET` ile admin şifresini değiştirin.

```bash
npm start
```

Sonra:
`http://localhost:3000`

Varsayılan kullanıcı:
- E-posta: `admin@beaumont.local`
- Şifre: `.env` içindeki `ADMIN_PASSWORD`

## Veritabanı

`data/beaumont.sqlite` otomatik oluşturulur.

## Yedekler

`backups/` altında SQLite kopyaları günlük olarak oluşturulur. Uygulama ayrıca son 30 yedeği tutar.

## PDF

Aylık Özet ve Ekonomik Durum ekranlarında gerçek PDF dosyası oluşturulur.

## Canlıya alma

Bu proje production'a alınabilecek backend yapısına sahiptir. Canlı sunucuda HTTPS, güçlü SESSION_SECRET, reverse proxy ve düzenli harici backup önerilir.
