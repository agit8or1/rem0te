import { SetMetadata } from '@nestjs/common';
import { API_SCOPES_KEY } from './apikey-auth.guard';
import type { ApiScope } from './apikeys.service';

/** Declare required API scopes for a public-API handler. */
export const RequireScopes = (...scopes: ApiScope[]) => SetMetadata(API_SCOPES_KEY, scopes);
