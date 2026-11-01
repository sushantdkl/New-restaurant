# 🍽️ Restaurant POS System

A modern, offline-first **Hybrid Point of Sale System** designed specifically for restaurant operations with multi-role support, real-time synchronization, and comprehensive management features.

## 📋 Quick Links

- **[Getting Started](GETTING_STARTED.md)** - Installation and setup guide
- **[API Testing](API_TESTING.md)** - Complete API endpoint documentation
- **[Project Overview](PROJECT_OVERVIEW.md)** - Comprehensive project details
- **[Build Status](BUILD_STATUS.md)** - Current development status

## 🎯 Current Status

### ✅ Phase 1: Backend Infrastructure (COMPLETE)
- Complete database schema with 20+ tables
- 5 repository classes for data access
- 8 REST API endpoints
- PIN-based authentication system
- Role-based access control (RBAC)
- Seeded with realistic sample data

### ⏳ Phase 2: Frontend UI (Next)
- UI component library
- Login interface
- Waiter app
- Kitchen display system
- Cashier/billing system
- Admin dashboard

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Initialize Database
```bash
npm run db:seed
```

This creates `pos_restaurant.db` with:
- 5 default users
- 10 restaurant tables
- 32 menu items
- System settings

### 3. Start Development Server
```bash
npm run dev
```

Server runs at: **http://localhost:3000**

## 🔑 Default Login Credentials

| Role | Username | PIN | Access Level |
|------|----------|-----|--------------|
| **Admin** | admin | 123456 | Full system access |
| **Waiter** | john | 1234 | Orders, tables, menu |
| **Waiter** | ram | 4567 | Orders, tables, menu |
| **Cashier** | sita | 7890 | Bills, payments, orders |
| **Kitchen** | chef | 1111 | KOTs, order status |

## 📡 API Endpoints

### Authentication
- `POST /api/auth/login` - User authentication
- `POST /api/auth/logout` - End session
- `POST /api/auth/verify` - Verify token

### Restaurant Operations
- `/api/restaurant/menu` - Menu management
- `/api/restaurant/tables` - Table operations
- `/api/restaurant/orders` - Order management
- `/api/restaurant/kots` - Kitchen order tickets
- `/api/restaurant/bills` - Billing & payments

**Full API documentation**: See [API_TESTING.md](API_TESTING.md)

## 🏗️ Tech Stack

- **Frontend**: Next.js 16, React 19, TailwindCSS, Radix UI
- **Backend**: Next.js API Routes (App Router)
- **Database**: SQLite with Better-SQLite3
- **Auth**: PIN-based with SHA-256 hashing
- **Real-time**: Socket.io (planned)
- **Offline**: IndexedDB (planned)

## 🎨 Features

### Implemented ✅
- Multi-user authentication with PIN
- Role-based permissions (Admin, Cashier, Waiter, Kitchen)
- Order management with status tracking
- Table assignment and management
- Kitchen Order Ticket (KOT) system
- Bill generation with auto-calculation
- Menu management with categories
- Payment processing
- Sales reporting

### Planned 📅
- Real-time WebSocket synchronization
- Offline mode with IndexedDB
- Receipt printing
- Multi-branch support
- Advanced analytics
- Hardware integration (printers, scanners)

## 🧪 Quick Test (PowerShell)

```powershell
# Login
$response = Invoke-RestMethod -Uri "http://localhost:3000/api/auth/login" `
  -Method POST -ContentType "application/json" `
  -Body '{"username":"admin","pin":"123456","deviceId":"test-device"}'

$token = $response.token

# Get Menu
Invoke-RestMethod -Uri "http://localhost:3000/api/restaurant/menu" `
  -Method GET -Headers @{Authorization="Bearer $token"}
```

## 📚 Documentation

- **[SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md)** - Complete system design
- **[DATABASE_SCHEMA.md](DATABASE_SCHEMA.md)** - Database structure
- **[UI_UX_WIREFRAMES.md](UI_UX_WIREFRAMES.md)** - Interface designs
- **[WORKFLOW_MAP.md](WORKFLOW_MAP.md)** - Operational workflows
- **[IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md)** - 20-week plan

## 🛠️ NPM Scripts

```bash
npm run dev        # Start development server
npm run build      # Build for production
npm run start      # Start production server
npm run db:seed    # Initialize database
npm run db:reset   # Reset database
```

## 📈 Metrics

- **Backend**: 100% Complete ✅
- **Database Tables**: 20+
- **API Endpoints**: 8
- **Code Lines**: ~3,500+
- **Sample Records**: 66

## 🎊 What's Built

✅ Complete database with 20+ tables  
✅ 5 repository classes for clean data access  
✅ 8 REST API endpoints with authentication  
✅ PIN-based auth with role-based permissions  
✅ Seeded with realistic restaurant data  
✅ Comprehensive documentation  

## 🚀 What's Next

⏳ UI component library  
⏳ Login screen with PIN pad  
⏳ Waiter app interface  
⏳ Kitchen display system  
⏳ Cashier/billing interface  
⏳ Admin dashboard  

---

**Status**: Backend Complete ✅ | Ready for UI Development  
**Version**: 1.0.0 (Phase 1)  

🍽️ **Built for restaurants, by developers who care!**
