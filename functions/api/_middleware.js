import { corsHeaders, errorHandling, telemetryData } from '../utils/middleware.js';

export const onRequest = [corsHeaders, errorHandling, telemetryData];