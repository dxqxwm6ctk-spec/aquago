import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'v2:required-permissions';

/**
 * يعلّم الـ endpoint بالصلاحيات المطلوبة، مثل:
 *   @RequirePermissions('drivers.view')
 * الفحص والعزل يتولاهما PermissionsGuard.
 */
export const RequirePermissions = (...keys: string[]) =>
  SetMetadata(PERMISSIONS_KEY, keys);
