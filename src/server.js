const express = require("express");
const cookieSession = require("cookie-session");
const bcrypt = require("bcryptjs");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret-change-me";
const backupDir = process.env.BACKUP_DIR || path.join(__dirname, "..", "backups");
fs.mkdirSync(backupDir, { recursive: true });

app.use(express.json({limit:"2mb"}));
app.use(express.urlencoded({extended:true}));
app.use(cookieSession({
  name:"beaumont_session",
  keys:[SESSION_SECRET],
  httpOnly:true,
  sameSite:"lax",
  secure:false,
  maxAge:1000*60*60*12
}));
app.use(express.static(path.join(__dirname,"..","public")));

function auth(req,res,next){
  if(!req.session.user) return res.status(401).json({error:"Oturum gerekli"});
  next();
}
function isoNow(){return new Date().toISOString();}
function monthOf(d){return String(d).slice(0,7);}
function num(v){const n=Number(v);return Number.isFinite(n)?n:0;}

const adminEmail = process.env.ADMIN_EMAIL || "admin@beaumont.local";
const adminPassword = process.env.ADMIN_PASSWORD || "ChangeMe123!";
if(!db.prepare("SELECT id FROM users WHERE email=?").get(adminEmail)){
  db.prepare("INSERT INTO users(email,password_hash,name) VALUES(?,?,?)")
    .run(adminEmail,bcrypt.hashSync(adminPassword,12),"Beaumont Admin");
}

app.get("/api/rates", async (req,res)=>{
  try{
    const r = await fetch(
      "https://api.frankfurter.app/latest?from=EUR&to=USD,GBP,CHF,TRY"
    );

    if(!r.ok) throw new Error("Döviz servisi cevap vermedi");

    const data = await r.json();

    res.json(data);
  }catch(e){
    console.error("Döviz kuru hatası:", e.message);
    res.status(503).json({error:"Döviz kurları şu anda alınamadı"});
  }
});

app.get("/api/session",(req,res)=>res.json({user:req.session.user||null}));

app.post("/api/login",(req,res)=>{
  const {email,password}=req.body;
  const u=db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if(!u || !bcrypt.compareSync(password||"",u.password_hash)) return res.status(401).json({error:"E-posta veya şifre hatalı"});
  req.session.user={id:u.id,email:u.email,name:u.name};
  res.json({ok:true,user:req.session.user});
});
app.post("/api/logout",(req,res)=>{req.session=null;res.json({ok:true})});

app.get("/api/dashboard",auth,(req,res)=>{
  const today=new Date().toISOString().slice(0,10), month=today.slice(0,7);
  const todayOrders=db.prepare("SELECT COUNT(*) c FROM orders WHERE substr(order_date,1,10)=?").get(today).c;
  const mo=db.prepare("SELECT COUNT(*) c,COALESCE(SUM(revenue),0) revenue,COALESCE(SUM(profit),0) profit FROM orders WHERE substr(order_date,1,7)=?").get(month);
  const events=db.prepare("SELECT * FROM events WHERE event_date=? ORDER BY event_time").all(today);
  const lowStock=db.prepare("SELECT * FROM stocks WHERE qty<=5 ORDER BY qty,name LIMIT 10").all();
  res.json({today, todayOrders, monthOrders:mo.c, monthRevenue:mo.revenue, monthProfit:mo.profit, events, lowStock});
});

app.get("/api/stocks",auth,(req,res)=>res.json(db.prepare("SELECT * FROM stocks ORDER BY name").all()));
app.post("/api/stocks",auth,(req,res)=>{
  const b=req.body;
  const r=db.prepare("INSERT INTO stocks(name,qty,humidor,sale_price,cost_price,pack_qty) VALUES(?,?,?,?,?,?)")
    .run(b.name,num(b.qty),b.humidor||"",num(b.sale_price),num(b.cost_price),Math.max(1,num(b.pack_qty)||1));
  res.json({id:r.lastInsertRowid});
});
app.put("/api/stocks/:id",auth,(req,res)=>{
  const b=req.body;
  db.prepare("UPDATE stocks SET name=?,qty=?,humidor=?,sale_price=?,cost_price=?,pack_qty=? WHERE id=?")
    .run(b.name,num(b.qty),b.humidor||"",num(b.sale_price),num(b.cost_price),Math.max(1,num(b.pack_qty)||1),req.params.id);
  res.json({ok:true});
});
app.delete("/api/stocks/:id",auth,(req,res)=>{db.prepare("DELETE FROM stocks WHERE id=?").run(req.params.id);res.json({ok:true})});
app.post("/api/stocks/:id/adjust",auth,(req,res)=>{
  const delta=num(req.body.delta), s=db.prepare("SELECT * FROM stocks WHERE id=?").get(req.params.id);
  if(!s)return res.status(404).json({error:"Stok bulunamadı"});
  const next=Math.max(0,s.qty+delta);
  db.prepare("UPDATE stocks SET qty=? WHERE id=?").run(next,s.id);
  res.json({qty:next});
});

app.get("/api/customers",auth,(req,res)=>{
  const cs=db.prepare("SELECT * FROM customers ORDER BY name").all();
  const ad=db.prepare("SELECT * FROM customer_addresses").all();
  const map=new Map();
  ad.forEach(a=>{if(!map.has(a.customer_id))map.set(a.customer_id,[]);map.get(a.customer_id).push(a)});
  res.json(cs.map(c=>({...c,addresses:map.get(c.id)||[]})));
});
app.post("/api/customers",auth,(req,res)=>{
  const b=req.body;
  const tx=db.transaction(()=>{
    const r=db.prepare("INSERT INTO customers(name,phone,notes) VALUES(?,?,?)").run(b.name,b.phone||"",b.notes||"");
    for(const a of (b.addresses||[])) if(a.title||a.address)
      db.prepare("INSERT INTO customer_addresses(customer_id,title,address) VALUES(?,?,?)").run(r.lastInsertRowid,a.title||"Adres",a.address||"");
    return r.lastInsertRowid;
  });
  res.json({id:tx()});
});
app.put("/api/customers/:id",auth,(req,res)=>{
  const b=req.body;
  const tx=db.transaction(()=>{
    db.prepare("UPDATE customers SET name=?,phone=?,notes=? WHERE id=?").run(b.name,b.phone||"",b.notes||"",req.params.id);
    db.prepare("DELETE FROM customer_addresses WHERE customer_id=?").run(req.params.id);
    for(const a of (b.addresses||[])) if(a.title||a.address)
      db.prepare("INSERT INTO customer_addresses(customer_id,title,address) VALUES(?,?,?)").run(req.params.id,a.title||"Adres",a.address||"");
  });
  tx();res.json({ok:true});
});
app.delete("/api/customers/:id",auth,(req,res)=>{db.prepare("DELETE FROM customers WHERE id=?").run(req.params.id);res.json({ok:true})});

app.get("/api/orders",auth,(req,res)=>{
  const orders=db.prepare("SELECT * FROM orders ORDER BY datetime(order_date) DESC").all();
  const items=db.prepare("SELECT * FROM order_items ORDER BY id").all();
  const map=new Map();
  items.forEach(i=>{if(!map.has(i.order_id))map.set(i.order_id,[]);map.get(i.order_id).push(i)});
  res.json(orders.map(o=>({...o,items:map.get(o.id)||[]})));
});
app.post("/api/orders",auth,(req,res)=>{
  const b=req.body;
  if(!b.buyer_name || !Array.isArray(b.items) || !b.items.length)return res.status(400).json({error:"Alıcı ve en az bir ürün gerekli"});
  const tx=db.transaction(()=>{
    let revenue=0,profit=0, resolved=[];
    for(const it of b.items){
      const s=db.prepare("SELECT * FROM stocks WHERE id=?").get(it.stock_id);
      const q=Math.floor(num(it.qty));
      if(!s || q<1) throw new Error("Geçersiz ürün");
      if(s.qty<q) throw new Error(`Yetersiz stok: ${s.name}`);
      revenue+=s.sale_price*q;
      profit+=(s.sale_price-s.cost_price)*q;
      resolved.push({s,q});
    }
    const order=db.prepare(`INSERT INTO orders(customer_id,buyer_name,phone,address,manual_note,order_date,revenue,profit)
      VALUES(?,?,?,?,?,?,?,?)`).run(b.customer_id||null,b.buyer_name,b.phone||"",b.address||"",b.manual_note||"",b.order_date||isoNow(),revenue,profit);
    for(const {s,q} of resolved){
      db.prepare("INSERT INTO order_items(order_id,stock_id,product_name,qty,sale_price,cost_price) VALUES(?,?,?,?,?,?)")
        .run(order.lastInsertRowid,s.id,s.name,q,s.sale_price,s.cost_price);
      db.prepare("UPDATE stocks SET qty=qty-? WHERE id=?").run(q,s.id);
    }
    db.prepare("INSERT INTO transactions(order_id,type,category,description,amount,tx_date) VALUES(?,?,?,?,?,?)")
      .run(order.lastInsertRowid,"income","Satış",`Sipariş — ${b.buyer_name}`,revenue,b.order_date||isoNow());
    return order.lastInsertRowid;
  });
  try{res.json({id:tx()})}catch(e){res.status(400).json({error:e.message})}
});
app.delete("/api/orders/:id",auth,(req,res)=>{
  const tx=db.transaction(()=>{
    const o=db.prepare("SELECT * FROM orders WHERE id=?").get(req.params.id);
    if(!o)throw new Error("Sipariş bulunamadı");
    const items=db.prepare("SELECT * FROM order_items WHERE order_id=?").all(o.id);
    for(const i of items) if(i.stock_id) db.prepare("UPDATE stocks SET qty=qty+? WHERE id=?").run(i.qty,i.stock_id);
    db.prepare("DELETE FROM transactions WHERE order_id=?").run(o.id);
    db.prepare("DELETE FROM orders WHERE id=?").run(o.id);
  });
  try{tx();res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}
});

app.get("/api/monthly/:month",auth,(req,res)=>{
  const m=req.params.month;
  const summary=db.prepare(`SELECT COUNT(*) count,COALESCE(SUM(revenue),0) revenue,COALESCE(SUM(profit),0) profit
    FROM orders WHERE substr(order_date,1,7)=?`).get(m);
  const orders=db.prepare("SELECT * FROM orders WHERE substr(order_date,1,7)=? ORDER BY datetime(order_date) DESC").all(m);
  const tx=db.prepare("SELECT * FROM transactions WHERE substr(tx_date,1,7)=? ORDER BY datetime(tx_date) DESC").all(m);
  res.json({month:m,...summary,orders,transactions:tx});
});

app.get("/api/transactions",auth,(req,res)=>res.json(db.prepare("SELECT * FROM transactions ORDER BY datetime(tx_date) DESC").all()));
app.post("/api/transactions",auth,(req,res)=>{
  const b=req.body;
  const r=db.prepare("INSERT INTO transactions(type,category,description,amount,tx_date) VALUES(?,?,?,?,?)")
    .run(b.type,b.category,b.description||"",num(b.amount),b.tx_date||isoNow());
  res.json({id:r.lastInsertRowid});
});
app.delete("/api/transactions/:id",auth,(req,res)=>{db.prepare("DELETE FROM transactions WHERE id=? AND order_id IS NULL").run(req.params.id);res.json({ok:true})});

app.get("/api/economy/:month",auth,(req,res)=>{
  const m=req.params.month;
  const rows=db.prepare("SELECT * FROM transactions WHERE substr(tx_date,1,7)=? ORDER BY datetime(tx_date) DESC").all(m);
  const income=rows.filter(x=>x.type==="income").reduce((s,x)=>s+x.amount,0);
  const expense=rows.filter(x=>x.type==="expense").reduce((s,x)=>s+x.amount,0);
  res.json({month:m,income,expense,net:income-expense,rows});
});

app.get("/api/events",auth,(req,res)=>res.json(db.prepare("SELECT * FROM events ORDER BY event_date,event_time").all()));
app.post("/api/events",auth,(req,res)=>{
  const b=req.body; const profit=num(b.income)-num(b.expense);
  const r=db.prepare(`INSERT INTO events(title,menu,venue,event_date,event_time,fee,members,income,expense,profit)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(b.title,b.menu||"",b.venue||"",b.event_date,b.event_time||"",num(b.fee),b.members||"",num(b.income),num(b.expense),profit);
  res.json({id:r.lastInsertRowid});
});
app.put("/api/events/:id",auth,(req,res)=>{
  const b=req.body; const profit=num(b.income)-num(b.expense);
  db.prepare(`UPDATE events SET title=?,menu=?,venue=?,event_date=?,event_time=?,fee=?,members=?,income=?,expense=?,profit=? WHERE id=?`)
    .run(b.title,b.menu||"",b.venue||"",b.event_date,b.event_time||"",num(b.fee),b.members||"",num(b.income),num(b.expense),profit,req.params.id);
  res.json({ok:true});
});
app.delete("/api/events/:id",auth,(req,res)=>{db.prepare("DELETE FROM events WHERE id=?").run(req.params.id);res.json({ok:true})});

app.get("/api/notes",auth,(req,res)=>res.json(db.prepare("SELECT * FROM notes ORDER BY datetime(updated_at) DESC").all()));
app.post("/api/notes",auth,(req,res)=>{const r=db.prepare("INSERT INTO notes(title,body) VALUES(?,?)").run(req.body.title,req.body.body||"");res.json({id:r.lastInsertRowid})});
app.put("/api/notes/:id",auth,(req,res)=>{db.prepare("UPDATE notes SET title=?,body=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(req.body.title,req.body.body||"",req.params.id);res.json({ok:true})});
app.delete("/api/notes/:id",auth,(req,res)=>{db.prepare("DELETE FROM notes WHERE id=?").run(req.params.id);res.json({ok:true})});

app.get("/api/debts",auth,(req,res)=>res.json(db.prepare("SELECT * FROM debts ORDER BY id DESC").all()));
app.post("/api/debts",auth,(req,res)=>{const b=req.body;const r=db.prepare("INSERT INTO debts(person,type,description,amount,status) VALUES(?,?,?,?,?)").run(b.person,b.type,b.description||"",num(b.amount),b.status||"Açık");res.json({id:r.lastInsertRowid})});
app.put("/api/debts/:id",auth,(req,res)=>{const b=req.body;db.prepare("UPDATE debts SET person=?,type=?,description=?,amount=?,status=? WHERE id=?").run(b.person,b.type,b.description||"",num(b.amount),b.status||"Açık",req.params.id);res.json({ok:true})});
app.delete("/api/debts/:id",auth,(req,res)=>{db.prepare("DELETE FROM debts WHERE id=?").run(req.params.id);res.json({ok:true})});

app.get("/api/pdf/monthly/:month",auth,(req,res)=>{
  const m=req.params.month;
  const summary=db.prepare(`SELECT COUNT(*) count,COALESCE(SUM(revenue),0) revenue,COALESCE(SUM(profit),0) profit FROM orders WHERE substr(order_date,1,7)=?`).get(m);
  const orders=db.prepare("SELECT * FROM orders WHERE substr(order_date,1,7)=? ORDER BY datetime(order_date) DESC").all(m);
  const doc=new PDFDocument({margin:45});
  res.setHeader("Content-Type","application/pdf");
  res.setHeader("Content-Disposition",`attachment; filename="beaumont-${m}-aylik-ozet.pdf"`);
  doc.pipe(res);
  doc.fontSize(22).text("BEAUMONT CLUB", {align:"center"});
  doc.moveDown(.3).fontSize(16).text(`Aylık Özet — ${m}`, {align:"center"});
  doc.moveDown();
  doc.fontSize(12).text(`Sipariş: ${summary.count}`);
  doc.text(`Ciro: €${summary.revenue.toFixed(2)}`);
  doc.text(`Kâr: €${summary.profit.toFixed(2)}`);
  doc.moveDown();
  doc.fontSize(14).text("Siparişler");
  doc.moveDown(.5);
  orders.forEach(o=>{
    doc.fontSize(10).text(`${o.order_date} | ${o.buyer_name} | Ciro €${o.revenue.toFixed(2)} | Kâr €${o.profit.toFixed(2)}`);
  });
  doc.end();
});

app.get("/api/pdf/economy/:month",auth,(req,res)=>{
  const m=req.params.month;
  const rows=db.prepare("SELECT * FROM transactions WHERE substr(tx_date,1,7)=? ORDER BY datetime(tx_date) DESC").all(m);
  const income=rows.filter(x=>x.type==="income").reduce((s,x)=>s+x.amount,0);
  const expense=rows.filter(x=>x.type==="expense").reduce((s,x)=>s+x.amount,0);
  const doc=new PDFDocument({margin:45});
  res.setHeader("Content-Type","application/pdf");
  res.setHeader("Content-Disposition",`attachment; filename="beaumont-${m}-ekonomi.pdf"`);
  doc.pipe(res);
  doc.fontSize(22).text("BEAUMONT CLUB",{align:"center"});
  doc.moveDown(.3).fontSize(16).text(`Ekonomik Durum — ${m}`,{align:"center"});
  doc.moveDown().fontSize(12).text(`Toplam Gelir: €${income.toFixed(2)}`);
  doc.text(`Toplam Gider: €${expense.toFixed(2)}`);
  doc.text(`Net: €${(income-expense).toFixed(2)}`);
  doc.moveDown().fontSize(14).text("Hareketler");
  rows.forEach(t=>doc.fontSize(10).text(`${t.tx_date} | ${t.type==="income"?"Gelir":"Gider"} | ${t.category} | ${t.description||""} | €${t.amount.toFixed(2)}`));
  doc.end();
});

function backup(){
  try{
    const src=path.join(__dirname,"..","data","beaumont.sqlite");
    const target=path.join(backupDir,`beaumont-${new Date().toISOString().replace(/[:.]/g,"-")}.sqlite`);
    fs.copyFileSync(src,target);
    const all=fs.readdirSync(backupDir).filter(x=>x.endsWith(".sqlite")).sort().reverse();
    all.slice(30).forEach(x=>fs.unlinkSync(path.join(backupDir,x)));
  }catch(e){console.error("Backup:",e.message)}
}
setTimeout(backup,2000);
setInterval(backup,24*60*60*1000);

app.use((req,res)=>res.sendFile(path.join(__dirname,"..","public","index.html")));
app.listen(PORT,()=>console.log(`Beaumont Club running on http://localhost:${PORT}`));
