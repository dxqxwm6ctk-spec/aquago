-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "postgis";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "AgencyStatus" AS ENUM ('PENDING_APPROVAL', 'ACTIVE', 'PAUSED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "DriverStatus" AS ENUM ('OFFLINE', 'AVAILABLE', 'BUSY');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('CREATED', 'SEARCHING', 'WAITING_FOR_DRIVER', 'AGENCY_ASSIGNED', 'DRIVER_ASSIGNED', 'PICKED_UP', 'DELIVERING', 'COMPLETED', 'CANCELLED', 'SEARCH_FAILED');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AssignmentAction" AS ENUM ('AGENCY_SELECTED', 'AGENCY_SKIPPED', 'DRIVER_OFFER_SENT', 'DRIVER_ACCEPTED', 'DRIVER_REJECTED', 'OFFER_EXPIRED', 'AGENCY_FAILED', 'RETRY_STARTED', 'MANUAL_ASSIGNED', 'SEARCH_FAILED', 'DRIVER_CANCELLED', 'WAITING_STARTED', 'WAITING_RESUMED', 'WAITING_TIMEOUT');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('TOPUP', 'COMMISSION', 'ADJUSTMENT', 'REFUND');

-- CreateEnum
CREATE TYPE "RechargeStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('BANK_TRANSFER', 'CLIQ', 'EFAWATEERCOM', 'CASH');

-- CreateEnum
CREATE TYPE "RoleScope" AS ENUM ('PLATFORM', 'AGENCY');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "DevicePlatform" AS ENUM ('ANDROID', 'IOS', 'WEB');

-- CreateEnum
CREATE TYPE "DeviceApp" AS ENUM ('CUSTOMER', 'DRIVER');

-- CreateEnum
CREATE TYPE "CouponType" AS ENUM ('PERCENT', 'FIXED');

-- CreateEnum
CREATE TYPE "AppTarget" AS ENUM ('CUSTOMER', 'DRIVER');

-- CreateEnum
CREATE TYPE "OtpChannel" AS ENUM ('OPENWA', 'META_WHATSAPP', 'EMAIL');

-- CreateEnum
CREATE TYPE "LeadLicenseStatus" AS ENUM ('UNKNOWN', 'LICENSED', 'UNLICENSED', 'PENDING_VERIFICATION');

-- CreateEnum
CREATE TYPE "LeadApprovalStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "LeadSourceType" AS ENUM ('GOOGLE_MAPS', 'OFFICIAL_WEBSITE', 'FACEBOOK', 'INSTAGRAM', 'PUBLIC_DIRECTORY', 'GOVERNMENT_SOURCE', 'MANUAL', 'SELF_REGISTRATION', 'OTHER');

-- CreateEnum
CREATE TYPE "WhatsAppOptInStatus" AS ENUM ('UNKNOWN', 'OPTED_IN', 'OPTED_OUT');

-- CreateEnum
CREATE TYPE "LeadContactStatus" AS ENUM ('NOT_CONTACTED', 'CONTACTED', 'CONTACT_FAILED');

-- CreateEnum
CREATE TYPE "LeadResponseStatus" AS ENUM ('NO_RESPONSE', 'RESPONDED', 'INTERESTED', 'NOT_INTERESTED');

-- CreateEnum
CREATE TYPE "OutreachChannel" AS ENUM ('WHATSAPP', 'PHONE', 'SMS', 'EMAIL');

-- CreateEnum
CREATE TYPE "OutreachContactType" AS ENUM ('INITIAL_OUTREACH', 'FOLLOW_UP', 'MANUAL_CONTACT', 'SUPPORT');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'QUEUED', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "CampaignAudienceType" AS ENUM ('ALL_LEADS', 'PENDING_REVIEW_ONLY', 'APPROVED_ONLY', 'BY_AREA', 'MANUAL_SELECTION', 'CUSTOMERS', 'DRIVERS', 'AGENCY_STAFF', 'PLATFORM_STAFF', 'ALL_USERS', 'CUSTOM_LIST');

-- CreateEnum
CREATE TYPE "RecipientKind" AS ENUM ('LEAD', 'USER', 'LIST_MEMBER');

-- CreateEnum
CREATE TYPE "RecipientStatus" AS ENUM ('PENDING', 'QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'REPLIED', 'OPTED_OUT', 'SKIPPED');

-- CreateEnum
CREATE TYPE "WaDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "WaMessageType" AS ENUM ('TEXT', 'IMAGE', 'DOCUMENT', 'INTERACTIVE', 'TEMPLATE');

-- CreateEnum
CREATE TYPE "WaMessageStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'RECEIVED');

-- CreateEnum
CREATE TYPE "LeadImportStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "OnboardingFieldMode" AS ENUM ('HIDDEN', 'OPTIONAL', 'REQUIRED');

-- CreateEnum
CREATE TYPE "AgencyEntityType" AS ENUM ('SOLE_ESTABLISHMENT', 'LLC');

-- CreateEnum
CREATE TYPE "OnboardingStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'CHANGES_REQUESTED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "OnboardingDocStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('DRAFT', 'PENDING_AGENCY', 'PENDING_PLATFORM', 'ACTIVE', 'EXPIRED', 'TERMINATED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ContractSignerSide" AS ENUM ('AGENCY', 'PLATFORM');

-- CreateEnum
CREATE TYPE "WetCopyStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'UPLOADED', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ContractAlertKind" AS ENUM ('CONTRACT_EXPIRY', 'WET_COPY_DUE', 'LICENSE_EXPIRY', 'ONBOARDING_GRACE');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "phone" TEXT,
    "phoneVerifiedAt" TIMESTAMP(3),
    "googleUid" TEXT,
    "appleUid" TEXT,
    "username" TEXT,
    "email" TEXT,
    "passwordHash" TEXT,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "name" TEXT NOT NULL,
    "nameUpdatedAt" TIMESTAMP(3),
    "nameConfirmedAt" TIMESTAMP(3),
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "supportBlockedAt" TIMESTAMP(3),
    "supportBlockReason" TEXT,
    "avatarUrl" TEXT,
    "telegramChatId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "termsAcceptedAt" TIMESTAMP(3),
    "termsVersion" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpCode" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitViolation" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "userId" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateLimitViolation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "deviceInfo" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sessionId" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedReason" TEXT,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "scope" "RoleScope" NOT NULL,
    "agencyId" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "descAr" TEXT NOT NULL,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateTable
CREATE TABLE "UserRole" (
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "agencyId" TEXT,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("userId","roleId")
);

-- CreateTable
CREATE TABLE "City" (
    "id" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "City_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "District" (
    "id" TEXT NOT NULL,
    "cityId" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "geom" geometry(MultiPolygon, 4326),

    CONSTRAINT "District_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Neighborhood" (
    "id" TEXT NOT NULL,
    "districtId" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "geom" geometry(MultiPolygon, 4326),

    CONSTRAINT "Neighborhood_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Zone" (
    "id" TEXT NOT NULL,
    "cityId" TEXT NOT NULL,
    "neighborhoodId" TEXT,
    "nameAr" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "geom" geometry(Polygon, 4326) NOT NULL,

    CONSTRAINT "Zone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Address" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "street" TEXT NOT NULL,
    "building" TEXT,
    "floor" TEXT,
    "notes" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Address_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agency" (
    "id" TEXT NOT NULL,
    "cityId" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "status" "AgencyStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "autoDispatch" BOOLEAN NOT NULL DEFAULT false,
    "subscriptionEnabled" BOOLEAN NOT NULL DEFAULT true,
    "subscriptionMonthlyPriceOverride" DECIMAL(10,2),
    "rating" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Agency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyBranch" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "deliveryRadiusKm" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "locationConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "address" TEXT,
    "isMain" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "AgencyBranch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyCoverage" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "zoneId" TEXT,
    "neighborhoodId" TEXT,
    "districtId" TEXT,

    CONSTRAINT "AgencyCoverage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyWorkingHour" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "opensAt" TEXT NOT NULL,
    "closesAt" TEXT NOT NULL,

    CONSTRAINT "AgencyWorkingHour_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyHoliday" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "noteAr" TEXT,

    CONSTRAINT "AgencyHoliday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverProfile" (
    "userId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "branchId" TEXT,
    "status" "DriverStatus" NOT NULL DEFAULT 'OFFLINE',
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "vehiclePlate" TEXT,
    "vehicleCount" INTEGER NOT NULL DEFAULT 1,
    "vehiclePlates" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rating" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "currentLat" DOUBLE PRECISION,
    "currentLng" DOUBLE PRECISION,
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "DriverProfile_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "UploadedImage" (
    "id" TEXT NOT NULL,
    "data" BYTEA,
    "storageKey" TEXT,
    "mimeType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UploadedImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WaterBottleType" (
    "id" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "sizeLiters" DECIMAL(6,2) NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "imageUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WaterBottleType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppDeveloper" (
    "id" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "roleAr" TEXT,
    "url" TEXT,
    "avatarUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppDeveloper_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromoBanner" (
    "id" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "linkUrl" TEXT,
    "audience" "AppTarget" NOT NULL DEFAULT 'CUSTOMER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromoBanner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyBottleAvailability" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "bottleTypeId" TEXT NOT NULL,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgencyBottleAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderCounter" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "next" INTEGER NOT NULL DEFAULT 1,
    "prefix" TEXT NOT NULL DEFAULT 'JOR',
    "resetAt" TIMESTAMP(3),
    "resetById" TEXT,
    "resetFrom" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "agencyId" TEXT,
    "branchId" TEXT,
    "driverId" TEXT,
    "addressId" TEXT NOT NULL,
    "zoneId" TEXT,
    "neighborhoodId" TEXT,
    "districtId" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'CREATED',
    "deliveryLat" DOUBLE PRECISION NOT NULL,
    "deliveryLng" DOUBLE PRECISION NOT NULL,
    "addressText" TEXT NOT NULL,
    "subtotal" DECIMAL(10,2) NOT NULL,
    "commissionAmount" DECIMAL(10,2) NOT NULL,
    "discountAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "couponId" TEXT,
    "couponCode" TEXT,
    "total" DECIMAL(10,2) NOT NULL,
    "notes" TEXT,
    "rating" INTEGER,
    "ratingComment" TEXT,
    "ratedAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "cancelledByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "searchStartedAt" TIMESTAMP(3),
    "waitingSince" TIMESTAMP(3),
    "waitingUntil" TIMESTAMP(3),
    "redispatchAskedAt" TIMESTAMP(3),
    "redispatchReason" TEXT,
    "agencyAssignedAt" TIMESTAMP(3),
    "driverAssignedAt" TIMESTAMP(3),
    "pickedUpAt" TIMESTAMP(3),
    "arrivedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderMessage" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "bodyAr" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "bottleTypeId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderStatusHistory" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "actorUserId" TEXT,
    "noteAr" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverOffer" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "status" "OfferStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "DriverOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderAssignmentHistory" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "agencyId" TEXT,
    "driverId" TEXT,
    "action" "AssignmentAction" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderAssignmentHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DispatchSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "distanceWeight" DECIMAL(4,3) NOT NULL DEFAULT 0.35,
    "availabilityWeight" DECIMAL(4,3) NOT NULL DEFAULT 0.20,
    "driverAvailabilityWeight" DECIMAL(4,3) NOT NULL DEFAULT 0.20,
    "loadWeight" DECIMAL(4,3) NOT NULL DEFAULT 0.10,
    "ratingWeight" DECIMAL(4,3) NOT NULL DEFAULT 0.10,
    "responseRateWeight" DECIMAL(4,3) NOT NULL DEFAULT 0.05,
    "offerTimeoutSeconds" INTEGER NOT NULL DEFAULT 45,
    "manualAssignTimeoutSeconds" INTEGER NOT NULL DEFAULT 300,
    "maxWaitForDriverSeconds" INTEGER NOT NULL DEFAULT 900,
    "waitRetryIntervalSeconds" INTEGER NOT NULL DEFAULT 30,
    "maxDriversPerAgency" INTEGER NOT NULL DEFAULT 3,
    "maxDispatchRounds" INTEGER NOT NULL DEFAULT 2,
    "respectWorkingHours" BOOLEAN NOT NULL DEFAULT true,
    "maxAgenciesPerOrder" INTEGER NOT NULL DEFAULT 3,
    "lowBalanceThreshold" DECIMAL(12,2) NOT NULL DEFAULT 10,
    "minBalanceForDispatch" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "commissionPerOrder" DECIMAL(10,2) NOT NULL DEFAULT 0.50,
    "maxDeliveryRadiusKm" DOUBLE PRECISION NOT NULL DEFAULT 15,
    "showSupportAgentName" BOOLEAN NOT NULL DEFAULT true,
    "subscriptionMonthlyPrice" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "arrivalGeofenceEnabled" BOOLEAN NOT NULL DEFAULT true,
    "arrivalRadiusMeters" INTEGER NOT NULL DEFAULT 250,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DispatchSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionInvoice" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "paidAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionPayment" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "RechargeStatus" NOT NULL DEFAULT 'PENDING',
    "method" "PaymentMethod" NOT NULL,
    "noteAr" TEXT,
    "requestedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reference" TEXT,
    "reviewNoteAr" TEXT,

    CONSTRAINT "SubscriptionPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "balance" DECIMAL(12,2) NOT NULL DEFAULT 0,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "orderId" TEXT,
    "type" "LedgerEntryType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "balanceAfter" DECIMAL(12,2) NOT NULL,
    "reference" TEXT,
    "noteAr" TEXT,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RechargeRequest" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" "RechargeStatus" NOT NULL DEFAULT 'PENDING',
    "method" "PaymentMethod" NOT NULL,
    "noteAr" TEXT,
    "requestedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reference" TEXT,
    "reviewNoteAr" TEXT,
    "ledgerEntryId" TEXT,

    CONSTRAINT "RechargeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAccount" (
    "id" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "holderNameAr" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "paymentLink" TEXT,
    "bankNameAr" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "companyNameAr" TEXT DEFAULT 'غاز الأردن — GasGO',
    "companyNameEn" TEXT,
    "taxNumber" TEXT,
    "licenseNumber" TEXT,
    "addressAr" TEXT DEFAULT 'عمّان، الأردن',
    "phone" TEXT,
    "email" TEXT,
    "website" TEXT,
    "logoUrl" TEXT,
    "financeContact" TEXT,
    "footerNoteAr" TEXT,
    "showLogo" BOOLEAN NOT NULL DEFAULT true,
    "showCompanyNameAr" BOOLEAN NOT NULL DEFAULT true,
    "showCompanyNameEn" BOOLEAN NOT NULL DEFAULT false,
    "showTaxNumber" BOOLEAN NOT NULL DEFAULT true,
    "showLicenseNumber" BOOLEAN NOT NULL DEFAULT true,
    "showAddress" BOOLEAN NOT NULL DEFAULT true,
    "showPhone" BOOLEAN NOT NULL DEFAULT true,
    "showEmail" BOOLEAN NOT NULL DEFAULT true,
    "showWebsite" BOOLEAN NOT NULL DEFAULT false,
    "showCustomerName" BOOLEAN NOT NULL DEFAULT true,
    "showCustomerPhone" BOOLEAN NOT NULL DEFAULT false,
    "showDeliveryAddress" BOOLEAN NOT NULL DEFAULT true,
    "showAgencyName" BOOLEAN NOT NULL DEFAULT true,
    "showDriverName" BOOLEAN NOT NULL DEFAULT false,
    "showCommissionLine" BOOLEAN NOT NULL DEFAULT true,
    "showDiscountLine" BOOLEAN NOT NULL DEFAULT true,
    "showFinanceContact" BOOLEAN NOT NULL DEFAULT true,
    "showFooterNote" BOOLEAN NOT NULL DEFAULT true,
    "showStamp" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoicePublicLink" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "lastAccessedAt" TIMESTAMP(3),

    CONSTRAINT "InvoicePublicLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Coupon" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "descAr" TEXT,
    "type" "CouponType" NOT NULL,
    "value" DECIMAL(10,2) NOT NULL,
    "maxDiscount" DECIMAL(10,2),
    "minOrderTotal" DECIMAL(10,2),
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "usageLimit" INTEGER,
    "perUserLimit" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CouponCity" (
    "couponId" TEXT NOT NULL,
    "cityId" TEXT NOT NULL,

    CONSTRAINT "CouponCity_pkey" PRIMARY KEY ("couponId","cityId")
);

-- CreateTable
CREATE TABLE "CouponRedemption" (
    "id" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "userSeq" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CouponRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "titleAr" TEXT NOT NULL,
    "bodyAr" TEXT NOT NULL,
    "data" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" "DevicePlatform" NOT NULL,
    "app" "DeviceApp" NOT NULL DEFAULT 'CUSTOMER',
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "offers" BOOLEAN NOT NULL DEFAULT true,
    "orders" BOOLEAN NOT NULL DEFAULT true,
    "system" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "OtpChannelSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "channel" "OtpChannel" NOT NULL DEFAULT 'OPENWA',
    "waGatewayNumber" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "OtpChannelSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpChannelOverride" (
    "phone" TEXT NOT NULL,
    "channel" "OtpChannel" NOT NULL,
    "email" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "OtpChannelOverride_pkey" PRIMARY KEY ("phone")
);

-- CreateTable
CREATE TABLE "ReviewAccountConfig" (
    "app" "AppTarget" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "phone" TEXT NOT NULL,
    "code" TEXT,
    "requireCode" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByUserId" TEXT,

    CONSTRAINT "ReviewAccountConfig_pkey" PRIMARY KEY ("app")
);

-- CreateTable
CREATE TABLE "AppVersionConfig" (
    "app" "AppTarget" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "minVersion" TEXT NOT NULL,
    "updateMessageAr" TEXT NOT NULL DEFAULT 'يتوفر تحديث جديد للتطبيق — يجب التحديث للمتابعة',
    "downloadUrl" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppVersionConfig_pkey" PRIMARY KEY ("app")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTicket" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "TicketPriority" NOT NULL DEFAULT 'NORMAL',
    "subjectAr" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "orderId" TEXT,
    "agencyId" TEXT,
    "assignedToUserId" TEXT,
    "telegramMessageIds" JSONB,
    "telegramReplyIds" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketMessage" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "bodyAr" TEXT NOT NULL,
    "agentLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyLead" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "businessName" TEXT,
    "phoneNumber" TEXT,
    "whatsappNumber" TEXT,
    "alternativePhoneNumber" TEXT,
    "areaId" TEXT,
    "areaName" TEXT,
    "neighborhood" TEXT,
    "address" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "licenseStatus" "LeadLicenseStatus" NOT NULL DEFAULT 'UNKNOWN',
    "licenseNumber" TEXT,
    "licenseSource" TEXT,
    "licenseVerifiedAt" TIMESTAMP(3),
    "approvalStatus" "LeadApprovalStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "rejectionReason" TEXT,
    "dataSource" "LeadSourceType" NOT NULL DEFAULT 'MANUAL',
    "sourceUrl" TEXT,
    "whatsappAvailable" BOOLEAN NOT NULL DEFAULT false,
    "whatsappOptInStatus" "WhatsAppOptInStatus" NOT NULL DEFAULT 'UNKNOWN',
    "contactStatus" "LeadContactStatus" NOT NULL DEFAULT 'NOT_CONTACTED',
    "responseStatus" "LeadResponseStatus" NOT NULL DEFAULT 'NO_RESPONSE',
    "interested" BOOLEAN NOT NULL DEFAULT false,
    "registered" BOOLEAN NOT NULL DEFAULT false,
    "firstContactAt" TIMESTAMP(3),
    "lastContactAt" TIMESTAMP(3),
    "lastResponseAt" TIMESTAMP(3),
    "doNotContact" BOOLEAN NOT NULL DEFAULT false,
    "doNotContactAt" TIMESTAMP(3),
    "notes" TEXT,
    "agencyId" TEXT,
    "importId" TEXT,
    "appliedAt" TIMESTAMP(3),
    "applicantNote" TEXT,
    "possibleDuplicateOfId" TEXT,
    "duplicateReviewedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgencyLead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyApprovalHistory" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "oldStatus" "LeadApprovalStatus" NOT NULL,
    "newStatus" "LeadApprovalStatus" NOT NULL,
    "reason" TEXT,
    "changedById" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgencyApprovalHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyDataSource" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "sourceType" "LeadSourceType" NOT NULL,
    "sourceName" TEXT,
    "sourceUrl" TEXT,
    "externalId" TEXT,
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),
    "isPrimarySource" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgencyDataSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyWhatsAppContact" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "isValid" BOOLEAN NOT NULL DEFAULT false,
    "isAvailable" BOOLEAN NOT NULL DEFAULT false,
    "optInStatus" "WhatsAppOptInStatus" NOT NULL DEFAULT 'UNKNOWN',
    "optInSource" TEXT,
    "optedInAt" TIMESTAMP(3),
    "optedOutAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgencyWhatsAppContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyOutreach" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "channel" "OutreachChannel" NOT NULL,
    "contactType" "OutreachContactType" NOT NULL,
    "phoneNumber" TEXT,
    "campaignId" TEXT,
    "messageId" TEXT,
    "status" TEXT,
    "contactedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgencyOutreach_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppCampaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "templateName" TEXT NOT NULL,
    "templateLanguage" TEXT NOT NULL DEFAULT 'ar',
    "templateBody" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "audienceType" "CampaignAudienceType" NOT NULL DEFAULT 'PENDING_REVIEW_ONLY',
    "areaId" TEXT,
    "listId" TEXT,
    "metaTemplateName" TEXT,
    "metaTemplateLang" TEXT NOT NULL DEFAULT 'ar',
    "metaTemplateParams" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "totalRecipients" INTEGER NOT NULL DEFAULT 0,
    "queuedCount" INTEGER NOT NULL DEFAULT 0,
    "sendingCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "deliveredCount" INTEGER NOT NULL DEFAULT 0,
    "readCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "repliedCount" INTEGER NOT NULL DEFAULT 0,
    "optedOutCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignRecipient" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "kind" "RecipientKind" NOT NULL DEFAULT 'LEAD',
    "leadId" TEXT,
    "userId" TEXT,
    "listMemberId" TEXT,
    "phoneNumber" TEXT NOT NULL,
    "status" "RecipientStatus" NOT NULL DEFAULT 'PENDING',
    "messageId" TEXT,
    "queuedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "repliedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "failureReason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppMessage" (
    "id" TEXT NOT NULL,
    "leadId" TEXT,
    "campaignId" TEXT,
    "recipientId" TEXT,
    "phoneNumber" TEXT NOT NULL,
    "direction" "WaDirection" NOT NULL,
    "messageType" "WaMessageType" NOT NULL DEFAULT 'TEXT',
    "templateName" TEXT,
    "templateLanguage" TEXT,
    "body" TEXT,
    "externalMessageId" TEXT,
    "status" "WaMessageStatus" NOT NULL DEFAULT 'PENDING',
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyLeadImport" (
    "id" TEXT NOT NULL,
    "fileName" TEXT,
    "status" "LeadImportStatus" NOT NULL DEFAULT 'PENDING',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "errorLog" JSONB,
    "startedById" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgencyLeadImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyCtaConfig" (
    "app" "AppTarget" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "titleAr" TEXT NOT NULL DEFAULT 'هل أنت صاحب وكالة غاز؟',
    "bodyAr" TEXT NOT NULL DEFAULT 'انضم إلى GasGO ووصّل طلبات منطقتك',
    "ctaAr" TEXT NOT NULL DEFAULT 'تواصل الآن',
    "url" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgencyCtaConfig_pkey" PRIMARY KEY ("app")
);

-- CreateTable
CREATE TABLE "WhatsAppOptOut" (
    "id" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppOptOut_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipientList" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipientList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipientListMember" (
    "id" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "name" TEXT,
    "leadId" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecipientListMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyOnboardingRequirement" (
    "key" TEXT NOT NULL,
    "mode" "OnboardingFieldMode" NOT NULL,
    "labelAr" TEXT,
    "hintAr" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "AgencyOnboardingRequirement_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AgencyOnboarding" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "status" "OnboardingStatus" NOT NULL DEFAULT 'DRAFT',
    "entityType" "AgencyEntityType",
    "legalNameAr" TEXT,
    "commercialRegistryNo" TEXT,
    "nationalEstablishmentNo" TEXT,
    "registeredAt" DATE,
    "registryPlace" TEXT,
    "officialEmail" TEXT,
    "addrGovernorate" TEXT,
    "addrDistrict" TEXT,
    "addrNeighborhood" TEXT,
    "addrStreet" TEXT,
    "addrBuildingNo" TEXT,
    "addrPostalCode" TEXT,
    "ownerSigns" BOOLEAN NOT NULL DEFAULT true,
    "proxyNumber" TEXT,
    "proxyDate" DATE,
    "signerName" TEXT,
    "signerNationality" TEXT,
    "signerNationalId" TEXT,
    "signerBirthDate" DATE,
    "signerPhone" TEXT,
    "signerRole" TEXT,
    "taxNumber" TEXT,
    "vatRegistered" BOOLEAN,
    "vatNumber" TEXT,
    "bankNameAr" TEXT,
    "bankBranch" TEXT,
    "accountHolderName" TEXT,
    "iban" TEXT,
    "walletAlias" TEXT,
    "submittedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgencyOnboarding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyOnboardingLicense" (
    "id" TEXT NOT NULL,
    "onboardingId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "number" TEXT,
    "issuedAt" DATE,
    "expiresAt" DATE,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgencyOnboardingLicense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyOnboardingDocument" (
    "id" TEXT NOT NULL,
    "onboardingId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "data" BYTEA,
    "storageKey" TEXT,
    "mimeType" TEXT NOT NULL,
    "fileName" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "status" "OnboardingDocStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,

    CONSTRAINT "AgencyOnboardingDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyOnboardingEvent" (
    "id" TEXT NOT NULL,
    "onboardingId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "note" TEXT,
    "actorId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgencyOnboardingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractTemplate" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "titleAr" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "notesAr" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "ContractTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "platformLegalNameAr" TEXT NOT NULL DEFAULT 'GasGo',
    "platformEntityTypeAr" TEXT,
    "platformNationalNo" TEXT,
    "platformRegistryNo" TEXT,
    "platformTaxNumber" TEXT,
    "platformAddressAr" TEXT,
    "platformSignerName" TEXT,
    "platformSignerRole" TEXT,
    "termMonths" INTEGER NOT NULL DEFAULT 12,
    "renewNoticeDays" INTEGER NOT NULL DEFAULT 30,
    "terminationNoticeDays" INTEGER NOT NULL DEFAULT 30,
    "commissionNoticeDays" INTEGER NOT NULL DEFAULT 30,
    "legacyGraceDays" INTEGER NOT NULL DEFAULT 60,
    "wetCopyDueDays" INTEGER NOT NULL DEFAULT 30,
    "wetCopyRequired" BOOLEAN NOT NULL DEFAULT true,
    "jurisdictionClauseAr" TEXT,
    "stampDutyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "stampDutyNoteAr" TEXT,
    "alertsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "alertCheckHours" INTEGER NOT NULL DEFAULT 6,
    "autoRenewOnExpiry" BOOLEAN NOT NULL DEFAULT true,
    "autoExpire" BOOLEAN NOT NULL DEFAULT true,
    "numberPrefix" TEXT NOT NULL DEFAULT 'GG-AGR',
    "nextSequence" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContractSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyContract" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "status" "ContractStatus" NOT NULL DEFAULT 'DRAFT',
    "contractDate" DATE NOT NULL,
    "startsAt" DATE,
    "endsAt" DATE,
    "autoRenew" BOOLEAN NOT NULL DEFAULT true,
    "subscriptionMonthly" DECIMAL(10,2),
    "serviceAreaAr" TEXT,
    "branchNameAr" TEXT,
    "renderedHtml" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "wetCopyStatus" "WetCopyStatus" NOT NULL DEFAULT 'PENDING',
    "wetCopyDueAt" TIMESTAMP(3),
    "wetCopyRejection" TEXT,
    "terminatedAt" TIMESTAMP(3),
    "terminationNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgencyContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractSignature" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "side" "ContractSignerSide" NOT NULL,
    "signerUserId" TEXT,
    "signerName" TEXT NOT NULL,
    "signerRole" TEXT,
    "signerPhone" TEXT,
    "signatureImage" BYTEA,
    "signatureImageKey" TEXT,
    "verificationMethod" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "documentHash" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractSignature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractDocument" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "data" BYTEA,
    "storageKey" TEXT,
    "mimeType" TEXT NOT NULL,
    "fileName" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedById" TEXT,

    CONSTRAINT "ContractDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractEvent" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "note" TEXT,
    "actorId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractPublicLink" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "lastAccessedAt" TIMESTAMP(3),

    CONSTRAINT "ContractPublicLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractAlertRule" (
    "id" TEXT NOT NULL,
    "kind" "ContractAlertKind" NOT NULL,
    "offsetDays" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notifyAgency" BOOLEAN NOT NULL DEFAULT true,
    "notifyPlatform" BOOLEAN NOT NULL DEFAULT false,
    "titleAr" TEXT NOT NULL,
    "bodyAr" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "ContractAlertRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractAlertLog" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "cycleKey" TEXT NOT NULL,
    "agencyId" TEXT,
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractAlertLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "User_googleUid_key" ON "User"("googleUid");

-- CreateIndex
CREATE UNIQUE INDEX "User_appleUid_key" ON "User"("appleUid");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramChatId_key" ON "User"("telegramChatId");

-- CreateIndex
CREATE INDEX "OtpCode_phone_idx" ON "OtpCode"("phone");

-- CreateIndex
CREATE INDEX "RateLimitViolation_scope_createdAt_idx" ON "RateLimitViolation"("scope", "createdAt");

-- CreateIndex
CREATE INDEX "RateLimitViolation_ip_idx" ON "RateLimitViolation"("ip");

-- CreateIndex
CREATE INDEX "RateLimitViolation_userId_idx" ON "RateLimitViolation"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_sessionId_idx" ON "RefreshToken"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Role_name_agencyId_key" ON "Role"("name", "agencyId");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_key_key" ON "Permission"("key");

-- CreateIndex
CREATE INDEX "UserRole_agencyId_idx" ON "UserRole"("agencyId");

-- CreateIndex
CREATE UNIQUE INDEX "City_nameAr_key" ON "City"("nameAr");

-- CreateIndex
CREATE INDEX "District_cityId_idx" ON "District"("cityId");

-- CreateIndex
CREATE UNIQUE INDEX "District_cityId_nameAr_key" ON "District"("cityId", "nameAr");

-- CreateIndex
CREATE INDEX "Neighborhood_districtId_idx" ON "Neighborhood"("districtId");

-- CreateIndex
CREATE UNIQUE INDEX "Neighborhood_districtId_nameAr_key" ON "Neighborhood"("districtId", "nameAr");

-- CreateIndex
CREATE INDEX "Zone_cityId_idx" ON "Zone"("cityId");

-- CreateIndex
CREATE INDEX "Zone_neighborhoodId_idx" ON "Zone"("neighborhoodId");

-- CreateIndex
CREATE INDEX "Address_userId_idx" ON "Address"("userId");

-- CreateIndex
CREATE INDEX "Agency_cityId_status_idx" ON "Agency"("cityId", "status");

-- CreateIndex
CREATE INDEX "AgencyBranch_agencyId_idx" ON "AgencyBranch"("agencyId");

-- CreateIndex
CREATE INDEX "AgencyCoverage_zoneId_idx" ON "AgencyCoverage"("zoneId");

-- CreateIndex
CREATE INDEX "AgencyCoverage_neighborhoodId_idx" ON "AgencyCoverage"("neighborhoodId");

-- CreateIndex
CREATE INDEX "AgencyCoverage_districtId_idx" ON "AgencyCoverage"("districtId");

-- CreateIndex
CREATE UNIQUE INDEX "AgencyCoverage_branchId_zoneId_key" ON "AgencyCoverage"("branchId", "zoneId");

-- CreateIndex
CREATE UNIQUE INDEX "AgencyCoverage_branchId_neighborhoodId_key" ON "AgencyCoverage"("branchId", "neighborhoodId");

-- CreateIndex
CREATE UNIQUE INDEX "AgencyCoverage_branchId_districtId_key" ON "AgencyCoverage"("branchId", "districtId");

-- CreateIndex
CREATE UNIQUE INDEX "AgencyWorkingHour_agencyId_dayOfWeek_opensAt_key" ON "AgencyWorkingHour"("agencyId", "dayOfWeek", "opensAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgencyHoliday_agencyId_date_key" ON "AgencyHoliday"("agencyId", "date");

-- CreateIndex
CREATE INDEX "DriverProfile_agencyId_status_idx" ON "DriverProfile"("agencyId", "status");

-- CreateIndex
CREATE INDEX "PromoBanner_audience_active_sort_idx" ON "PromoBanner"("audience", "active", "sort");

-- CreateIndex
CREATE UNIQUE INDEX "AgencyBottleAvailability_agencyId_bottleTypeId_key" ON "AgencyBottleAvailability"("agencyId", "bottleTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_code_key" ON "Order"("code");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE INDEX "Order_customerId_createdAt_idx" ON "Order"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "Order_agencyId_createdAt_idx" ON "Order"("agencyId", "createdAt");

-- CreateIndex
CREATE INDEX "Order_driverId_createdAt_idx" ON "Order"("driverId", "createdAt");

-- CreateIndex
CREATE INDEX "Order_neighborhoodId_idx" ON "Order"("neighborhoodId");

-- CreateIndex
CREATE INDEX "Order_districtId_idx" ON "Order"("districtId");

-- CreateIndex
CREATE INDEX "OrderMessage_orderId_createdAt_idx" ON "OrderMessage"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "OrderStatusHistory_orderId_idx" ON "OrderStatusHistory"("orderId");

-- CreateIndex
CREATE INDEX "DriverOffer_orderId_idx" ON "DriverOffer"("orderId");

-- CreateIndex
CREATE INDEX "DriverOffer_driverId_status_idx" ON "DriverOffer"("driverId", "status");

-- CreateIndex
CREATE INDEX "DriverOffer_agencyId_status_createdAt_idx" ON "DriverOffer"("agencyId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "OrderAssignmentHistory_orderId_createdAt_idx" ON "OrderAssignmentHistory"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "OrderAssignmentHistory_agencyId_action_createdAt_idx" ON "OrderAssignmentHistory"("agencyId", "action", "createdAt");

-- CreateIndex
CREATE INDEX "SubscriptionInvoice_agencyId_periodStart_idx" ON "SubscriptionInvoice"("agencyId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionInvoice_agencyId_periodStart_key" ON "SubscriptionInvoice"("agencyId", "periodStart");

-- CreateIndex
CREATE INDEX "SubscriptionPayment_status_createdAt_idx" ON "SubscriptionPayment"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SubscriptionPayment_agencyId_createdAt_idx" ON "SubscriptionPayment"("agencyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_agencyId_key" ON "Wallet"("agencyId");

-- CreateIndex
CREATE INDEX "LedgerEntry_walletId_createdAt_idx" ON "LedgerEntry"("walletId", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_orderId_idx" ON "LedgerEntry"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "RechargeRequest_ledgerEntryId_key" ON "RechargeRequest"("ledgerEntryId");

-- CreateIndex
CREATE INDEX "RechargeRequest_status_createdAt_idx" ON "RechargeRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "RechargeRequest_agencyId_createdAt_idx" ON "RechargeRequest"("agencyId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentAccount_isActive_method_sortOrder_idx" ON "PaymentAccount"("isActive", "method", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "InvoicePublicLink_orderId_key" ON "InvoicePublicLink"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoicePublicLink_tokenHash_key" ON "InvoicePublicLink"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Coupon_code_key" ON "Coupon"("code");

-- CreateIndex
CREATE INDEX "Coupon_active_endsAt_idx" ON "Coupon"("active", "endsAt");

-- CreateIndex
CREATE INDEX "CouponCity_cityId_idx" ON "CouponCity"("cityId");

-- CreateIndex
CREATE UNIQUE INDEX "CouponRedemption_orderId_key" ON "CouponRedemption"("orderId");

-- CreateIndex
CREATE INDEX "CouponRedemption_couponId_createdAt_idx" ON "CouponRedemption"("couponId", "createdAt");

-- CreateIndex
CREATE INDEX "CouponRedemption_customerId_idx" ON "CouponRedemption"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "CouponRedemption_couponId_customerId_userSeq_key" ON "CouponRedemption"("couponId", "customerId", "userSeq");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceToken_token_key" ON "DeviceToken"("token");

-- CreateIndex
CREATE INDEX "DeviceToken_userId_idx" ON "DeviceToken"("userId");

-- CreateIndex
CREATE INDEX "DeviceToken_userId_app_idx" ON "DeviceToken"("userId", "app");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_actorUserId_createdAt_idx" ON "AuditLog"("actorUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupportTicket_code_key" ON "SupportTicket"("code");

-- CreateIndex
CREATE INDEX "SupportTicket_status_priority_idx" ON "SupportTicket"("status", "priority");

-- CreateIndex
CREATE INDEX "SupportTicket_assignedToUserId_status_idx" ON "SupportTicket"("assignedToUserId", "status");

-- CreateIndex
CREATE INDEX "TicketMessage_ticketId_idx" ON "TicketMessage"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "AgencyLead_agencyId_key" ON "AgencyLead"("agencyId");

-- CreateIndex
CREATE INDEX "AgencyLead_phoneNumber_idx" ON "AgencyLead"("phoneNumber");

-- CreateIndex
CREATE INDEX "AgencyLead_whatsappNumber_idx" ON "AgencyLead"("whatsappNumber");

-- CreateIndex
CREATE INDEX "AgencyLead_areaId_idx" ON "AgencyLead"("areaId");

-- CreateIndex
CREATE INDEX "AgencyLead_licenseStatus_idx" ON "AgencyLead"("licenseStatus");

-- CreateIndex
CREATE INDEX "AgencyLead_approvalStatus_idx" ON "AgencyLead"("approvalStatus");

-- CreateIndex
CREATE INDEX "AgencyLead_doNotContact_idx" ON "AgencyLead"("doNotContact");

-- CreateIndex
CREATE INDEX "AgencyLead_licenseNumber_idx" ON "AgencyLead"("licenseNumber");

-- CreateIndex
CREATE INDEX "AgencyLead_deletedAt_idx" ON "AgencyLead"("deletedAt");

-- CreateIndex
CREATE INDEX "AgencyLead_appliedAt_idx" ON "AgencyLead"("appliedAt");

-- CreateIndex
CREATE INDEX "AgencyApprovalHistory_leadId_changedAt_idx" ON "AgencyApprovalHistory"("leadId", "changedAt");

-- CreateIndex
CREATE INDEX "AgencyDataSource_leadId_idx" ON "AgencyDataSource"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "AgencyDataSource_sourceType_externalId_key" ON "AgencyDataSource"("sourceType", "externalId");

-- CreateIndex
CREATE INDEX "AgencyWhatsAppContact_phoneNumber_idx" ON "AgencyWhatsAppContact"("phoneNumber");

-- CreateIndex
CREATE INDEX "AgencyWhatsAppContact_optInStatus_idx" ON "AgencyWhatsAppContact"("optInStatus");

-- CreateIndex
CREATE UNIQUE INDEX "AgencyWhatsAppContact_leadId_phoneNumber_key" ON "AgencyWhatsAppContact"("leadId", "phoneNumber");

-- CreateIndex
CREATE INDEX "AgencyOutreach_leadId_contactedAt_idx" ON "AgencyOutreach"("leadId", "contactedAt");

-- CreateIndex
CREATE INDEX "AgencyOutreach_campaignId_idx" ON "AgencyOutreach"("campaignId");

-- CreateIndex
CREATE INDEX "WhatsAppCampaign_status_idx" ON "WhatsAppCampaign"("status");

-- CreateIndex
CREATE INDEX "WhatsAppCampaign_createdAt_idx" ON "WhatsAppCampaign"("createdAt");

-- CreateIndex
CREATE INDEX "CampaignRecipient_campaignId_status_idx" ON "CampaignRecipient"("campaignId", "status");

-- CreateIndex
CREATE INDEX "CampaignRecipient_leadId_idx" ON "CampaignRecipient"("leadId");

-- CreateIndex
CREATE INDEX "CampaignRecipient_userId_idx" ON "CampaignRecipient"("userId");

-- CreateIndex
CREATE INDEX "CampaignRecipient_status_idx" ON "CampaignRecipient"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRecipient_campaignId_phoneNumber_key" ON "CampaignRecipient"("campaignId", "phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppMessage_externalMessageId_key" ON "WhatsAppMessage"("externalMessageId");

-- CreateIndex
CREATE INDEX "WhatsAppMessage_campaignId_idx" ON "WhatsAppMessage"("campaignId");

-- CreateIndex
CREATE INDEX "WhatsAppMessage_leadId_idx" ON "WhatsAppMessage"("leadId");

-- CreateIndex
CREATE INDEX "WhatsAppMessage_status_idx" ON "WhatsAppMessage"("status");

-- CreateIndex
CREATE INDEX "WhatsAppMessage_phoneNumber_createdAt_idx" ON "WhatsAppMessage"("phoneNumber", "createdAt");

-- CreateIndex
CREATE INDEX "AgencyLeadImport_status_createdAt_idx" ON "AgencyLeadImport"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppOptOut_phoneNumber_key" ON "WhatsAppOptOut"("phoneNumber");

-- CreateIndex
CREATE INDEX "WhatsAppOptOut_createdAt_idx" ON "WhatsAppOptOut"("createdAt");

-- CreateIndex
CREATE INDEX "RecipientList_createdAt_idx" ON "RecipientList"("createdAt");

-- CreateIndex
CREATE INDEX "RecipientListMember_phoneNumber_idx" ON "RecipientListMember"("phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "RecipientListMember_listId_phoneNumber_key" ON "RecipientListMember"("listId", "phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "AgencyOnboarding_agencyId_key" ON "AgencyOnboarding"("agencyId");

-- CreateIndex
CREATE INDEX "AgencyOnboarding_status_submittedAt_idx" ON "AgencyOnboarding"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "AgencyOnboardingLicense_expiresAt_idx" ON "AgencyOnboardingLicense"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgencyOnboardingLicense_onboardingId_key_key" ON "AgencyOnboardingLicense"("onboardingId", "key");

-- CreateIndex
CREATE INDEX "AgencyOnboardingDocument_status_idx" ON "AgencyOnboardingDocument"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AgencyOnboardingDocument_onboardingId_key_key" ON "AgencyOnboardingDocument"("onboardingId", "key");

-- CreateIndex
CREATE INDEX "AgencyOnboardingEvent_onboardingId_createdAt_idx" ON "AgencyOnboardingEvent"("onboardingId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContractTemplate_version_key" ON "ContractTemplate"("version");

-- CreateIndex
CREATE INDEX "ContractTemplate_isActive_idx" ON "ContractTemplate"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "AgencyContract_number_key" ON "AgencyContract"("number");

-- CreateIndex
CREATE INDEX "AgencyContract_agencyId_status_idx" ON "AgencyContract"("agencyId", "status");

-- CreateIndex
CREATE INDEX "AgencyContract_status_endsAt_idx" ON "AgencyContract"("status", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContractSignature_contractId_side_key" ON "ContractSignature"("contractId", "side");

-- CreateIndex
CREATE UNIQUE INDEX "ContractDocument_contractId_kind_key" ON "ContractDocument"("contractId", "kind");

-- CreateIndex
CREATE INDEX "ContractEvent_contractId_createdAt_idx" ON "ContractEvent"("contractId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContractPublicLink_contractId_key" ON "ContractPublicLink"("contractId");

-- CreateIndex
CREATE UNIQUE INDEX "ContractPublicLink_tokenHash_key" ON "ContractPublicLink"("tokenHash");

-- CreateIndex
CREATE INDEX "ContractAlertRule_kind_enabled_idx" ON "ContractAlertRule"("kind", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "ContractAlertRule_kind_offsetDays_key" ON "ContractAlertRule"("kind", "offsetDays");

-- CreateIndex
CREATE INDEX "ContractAlertLog_sentAt_idx" ON "ContractAlertLog"("sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContractAlertLog_ruleId_subjectKey_cycleKey_key" ON "ContractAlertLog"("ruleId", "subjectKey", "cycleKey");

-- AddForeignKey
ALTER TABLE "RateLimitViolation" ADD CONSTRAINT "RateLimitViolation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "District" ADD CONSTRAINT "District_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Neighborhood" ADD CONSTRAINT "Neighborhood_districtId_fkey" FOREIGN KEY ("districtId") REFERENCES "District"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_neighborhoodId_fkey" FOREIGN KEY ("neighborhoodId") REFERENCES "Neighborhood"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Address" ADD CONSTRAINT "Address_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agency" ADD CONSTRAINT "Agency_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyBranch" ADD CONSTRAINT "AgencyBranch_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyCoverage" ADD CONSTRAINT "AgencyCoverage_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyCoverage" ADD CONSTRAINT "AgencyCoverage_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "AgencyBranch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyCoverage" ADD CONSTRAINT "AgencyCoverage_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyCoverage" ADD CONSTRAINT "AgencyCoverage_neighborhoodId_fkey" FOREIGN KEY ("neighborhoodId") REFERENCES "Neighborhood"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyCoverage" ADD CONSTRAINT "AgencyCoverage_districtId_fkey" FOREIGN KEY ("districtId") REFERENCES "District"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyWorkingHour" ADD CONSTRAINT "AgencyWorkingHour_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyHoliday" ADD CONSTRAINT "AgencyHoliday_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverProfile" ADD CONSTRAINT "DriverProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverProfile" ADD CONSTRAINT "DriverProfile_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverProfile" ADD CONSTRAINT "DriverProfile_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "AgencyBranch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyBottleAvailability" ADD CONSTRAINT "AgencyBottleAvailability_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyBottleAvailability" ADD CONSTRAINT "AgencyBottleAvailability_bottleTypeId_fkey" FOREIGN KEY ("bottleTypeId") REFERENCES "WaterBottleType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderCounter" ADD CONSTRAINT "OrderCounter_resetById_fkey" FOREIGN KEY ("resetById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "AgencyBranch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_addressId_fkey" FOREIGN KEY ("addressId") REFERENCES "Address"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_neighborhoodId_fkey" FOREIGN KEY ("neighborhoodId") REFERENCES "Neighborhood"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_districtId_fkey" FOREIGN KEY ("districtId") REFERENCES "District"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderMessage" ADD CONSTRAINT "OrderMessage_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderMessage" ADD CONSTRAINT "OrderMessage_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_bottleTypeId_fkey" FOREIGN KEY ("bottleTypeId") REFERENCES "WaterBottleType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderStatusHistory" ADD CONSTRAINT "OrderStatusHistory_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverOffer" ADD CONSTRAINT "DriverOffer_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverOffer" ADD CONSTRAINT "DriverOffer_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverOffer" ADD CONSTRAINT "DriverOffer_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAssignmentHistory" ADD CONSTRAINT "OrderAssignmentHistory_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAssignmentHistory" ADD CONSTRAINT "OrderAssignmentHistory_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAssignmentHistory" ADD CONSTRAINT "OrderAssignmentHistory_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionInvoice" ADD CONSTRAINT "SubscriptionInvoice_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RechargeRequest" ADD CONSTRAINT "RechargeRequest_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RechargeRequest" ADD CONSTRAINT "RechargeRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RechargeRequest" ADD CONSTRAINT "RechargeRequest_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RechargeRequest" ADD CONSTRAINT "RechargeRequest_ledgerEntryId_fkey" FOREIGN KEY ("ledgerEntryId") REFERENCES "LedgerEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoicePublicLink" ADD CONSTRAINT "InvoicePublicLink_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponCity" ADD CONSTRAINT "CouponCity_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponCity" ADD CONSTRAINT "CouponCity_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceToken" ADD CONSTRAINT "DeviceToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtpChannelSettings" ADD CONSTRAINT "OtpChannelSettings_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtpChannelOverride" ADD CONSTRAINT "OtpChannelOverride_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewAccountConfig" ADD CONSTRAINT "ReviewAccountConfig_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyLead" ADD CONSTRAINT "AgencyLead_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "District"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyLead" ADD CONSTRAINT "AgencyLead_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyLead" ADD CONSTRAINT "AgencyLead_importId_fkey" FOREIGN KEY ("importId") REFERENCES "AgencyLeadImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyLead" ADD CONSTRAINT "AgencyLead_possibleDuplicateOfId_fkey" FOREIGN KEY ("possibleDuplicateOfId") REFERENCES "AgencyLead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyLead" ADD CONSTRAINT "AgencyLead_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyLead" ADD CONSTRAINT "AgencyLead_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyApprovalHistory" ADD CONSTRAINT "AgencyApprovalHistory_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "AgencyLead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyApprovalHistory" ADD CONSTRAINT "AgencyApprovalHistory_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyDataSource" ADD CONSTRAINT "AgencyDataSource_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "AgencyLead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyWhatsAppContact" ADD CONSTRAINT "AgencyWhatsAppContact_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "AgencyLead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyOutreach" ADD CONSTRAINT "AgencyOutreach_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "AgencyLead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyOutreach" ADD CONSTRAINT "AgencyOutreach_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "WhatsAppCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppCampaign" ADD CONSTRAINT "WhatsAppCampaign_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppCampaign" ADD CONSTRAINT "WhatsAppCampaign_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "District"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppCampaign" ADD CONSTRAINT "WhatsAppCampaign_listId_fkey" FOREIGN KEY ("listId") REFERENCES "RecipientList"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "WhatsAppCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "AgencyLead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_listMemberId_fkey" FOREIGN KEY ("listMemberId") REFERENCES "RecipientListMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppMessage" ADD CONSTRAINT "WhatsAppMessage_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "AgencyLead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppMessage" ADD CONSTRAINT "WhatsAppMessage_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "WhatsAppCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppMessage" ADD CONSTRAINT "WhatsAppMessage_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "CampaignRecipient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyLeadImport" ADD CONSTRAINT "AgencyLeadImport_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipientList" ADD CONSTRAINT "RecipientList_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipientListMember" ADD CONSTRAINT "RecipientListMember_listId_fkey" FOREIGN KEY ("listId") REFERENCES "RecipientList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyOnboardingRequirement" ADD CONSTRAINT "AgencyOnboardingRequirement_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyOnboarding" ADD CONSTRAINT "AgencyOnboarding_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyOnboarding" ADD CONSTRAINT "AgencyOnboarding_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyOnboardingLicense" ADD CONSTRAINT "AgencyOnboardingLicense_onboardingId_fkey" FOREIGN KEY ("onboardingId") REFERENCES "AgencyOnboarding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyOnboardingDocument" ADD CONSTRAINT "AgencyOnboardingDocument_onboardingId_fkey" FOREIGN KEY ("onboardingId") REFERENCES "AgencyOnboarding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyOnboardingDocument" ADD CONSTRAINT "AgencyOnboardingDocument_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyOnboardingEvent" ADD CONSTRAINT "AgencyOnboardingEvent_onboardingId_fkey" FOREIGN KEY ("onboardingId") REFERENCES "AgencyOnboarding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyOnboardingEvent" ADD CONSTRAINT "AgencyOnboardingEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractTemplate" ADD CONSTRAINT "ContractTemplate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyContract" ADD CONSTRAINT "AgencyContract_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyContract" ADD CONSTRAINT "AgencyContract_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ContractTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyContract" ADD CONSTRAINT "AgencyContract_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractSignature" ADD CONSTRAINT "ContractSignature_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "AgencyContract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractSignature" ADD CONSTRAINT "ContractSignature_signerUserId_fkey" FOREIGN KEY ("signerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractDocument" ADD CONSTRAINT "ContractDocument_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "AgencyContract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractDocument" ADD CONSTRAINT "ContractDocument_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractEvent" ADD CONSTRAINT "ContractEvent_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "AgencyContract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractEvent" ADD CONSTRAINT "ContractEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractPublicLink" ADD CONSTRAINT "ContractPublicLink_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "AgencyContract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractAlertRule" ADD CONSTRAINT "ContractAlertRule_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractAlertLog" ADD CONSTRAINT "ContractAlertLog_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "ContractAlertRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

