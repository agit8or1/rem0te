import type { PrismaService } from '../prisma/prisma.service';
import type { ActorContext } from '../rbac/access-control.service';
import type { NavList } from './model';

/**
 * The device ids on the caller's own favourites or recent list (0.89, UX
 * P1-3), for the device list's "My favourites" and "Recent devices" views.
 *
 * This is the one reader of UserNavItem outside navigation.service.ts (§96),
 * and it reads only the caller's own rows (`userId: actor.userId`), only
 * kind `device`, bounded by the lists' own caps. It returns ids, nothing
 * else, and decides no visibility: the device list ANDs them with its own
 * scopedWhere, so a favourite the caller can no longer see is simply not
 * listed. It is a plain function rather than a provider because
 * NavigationService already depends on EndpointListService.
 */
export async function myDeviceIds(prisma: PrismaService, actor: ActorContext, list: NavList): Promise<string[]> {
  const rows = await prisma.userNavItem.findMany({
    where: { userId: actor.userId, list, kind: 'device' },
    select: { ref: true },
    take: 50,
  });
  return rows.map((r) => r.ref);
}
