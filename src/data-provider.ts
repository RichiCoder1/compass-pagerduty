import {
    DataProviderResponse,
    DataProviderEventTypes,
    BuiltinMetricDefinitions,
    CompassCreateMetricDefinitionInput,
    default as graphqlGateway,
    DataProviderIncidentEvent,
    CompassIncidentEventState,
} from '@atlassian/forge-graphql';
import { storage, fetch } from '@forge/api';
import { format, subDays, secondsToMinutes } from 'date-fns';

type CustomMetric = Omit<CompassCreateMetricDefinitionInput, 'cloudId'>;
const CUSTOM_METRICS: CustomMetric[] = [];

export async function installed(event: any) {
    console.log({ install: event });
}

export async function dataProvider(request: { url: string }, context: unknown) {
    const { url } = request;

    const emptyResponse = new DataProviderResponse('pd:unknown', {
        builtInMetricDefinitions: [],
        customMetricDefinitions: [],
        eventTypes: [],
    }).build();

    console.log({ url });
    const parsed = new URL(url);
    const token = await storage.getSecret('api-token');
    if (!token) {
        console.warn(`PagerDuty token unset, skipping.`);
        return emptyResponse;
    }

    const [root, service] = parsed.pathname.substring(1).split('/');
    if (root !== 'service-directory') {
        console.info(`Skipping ${url}, not a service directory path.`);
        return emptyResponse;
    }
    if (!service) {
        console.info(`Missing service id from ${url}, skipping.`);
        return emptyResponse;
    }

    console.log(`Got service ${service}.`);

    const response = new DataProviderResponse(`pd:${service}`, {
        eventTypes: [DataProviderEventTypes.INCIDENTS],
        builtInMetricDefinitions: [BuiltinMetricDefinitions.MTTR_28D],
        customMetricDefinitions: CUSTOM_METRICS.map(({ format: _, ...metricDef }) => metricDef),
    });

    const now = new Date();
    const analyticsResult = await fetch(`https://api.pagerduty.com/analytics/metrics/incidents/services`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-EARLY-ACCESS': 'analytics-v2',
            Accept: 'application/vnd.pagerduty+json;version=2',
            Authorization: `Token token=${token}`,
        },
        body: JSON.stringify({
            filters: {
                created_at_start: format(subDays(now, 28), `yyyy-MM-dd'T'HH:mm:ssX`),
                created_at_end: format(now, `yyyy-MM-dd'T'HH:mm:ssX`),
                service_ids: [service],
                urgency: "high",
            },
            aggregate_unit: 'month',
        }),
    });

    if (!analyticsResult.ok) {
        console.warn(`Failed to get analytics for ${service} for ${url}`);
        console.warn(analyticsResult);
        return null;
    }

    const analytics = await analyticsResult.json();
    if (!Array.isArray(analytics?.data)) {
        console.warn({ analytics });
        throw new Error('Got invalid response when trying to get analytics data for service.');
    }

    const [last_month] = analytics.data;

    const incidentsResult = await fetch(`https://api.pagerduty.com/incidents?limit=100&service_ids[]=${service}`, {
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/vnd.pagerduty+json;version=2',
            Authorization: `Token token=${token}`,
        },
    });

    if (!incidentsResult.ok) {
        console.warn(`Failed to get incidents for ${service} for ${url}`);
        console.warn(incidentsResult);
        return null;
    }

    const incidentsData = await incidentsResult.json();
    if (!incidentsData?.incidents) {
        console.warn({ incidentsData });
        throw new Error('Got invalid response when trying to get incidents data for service.');
    }

    const { incidents } = incidentsData;

    return response
        .addBuiltInMetricValue(BuiltinMetricDefinitions.MTTR_28D, secondsToMinutes(last_month.mean_seconds_to_resolve ?? 0))
        .addIncidents(incidents.map(buildIncident))
        .build();
}

export async function dataProviderCallback(data: { success: boolean; url: string; errorMessage?: string }) {
    if (!data.success) {
        console.error({
            ...data,
        });
    }
}

export async function triggerSync(_: unknown, context: unknown) {
    try {
        const cloudId = getCloudId(context);
        const syncResult = await graphqlGateway.compass.asApp().synchronizeLinkAssociations({
            cloudId,
            forgeAppId: process.env.FORGE_APP_ID,
        });
        return {
            body: `${JSON.stringify(syncResult)}\n`,
            headers: { 'Content-Type': ['application/json'] },
            statusCode: syncResult.success ? 200 : 500,
            statusText: syncResult.success ? 'OK' : 'Server Error',
        };
    } catch (e) {
        return {
            body: `${JSON.stringify(e)}\n`,
            statusCode: 500,
        };
    }
}

function buildIncident(incident: any): DataProviderIncidentEvent {
    const event: DataProviderIncidentEvent = {
        id: incident.id,
        displayName: incident.title,
        description: incident.description,
        url: incident.html_url,
        state: incident.status == "resolved" ? CompassIncidentEventState.Resolved : CompassIncidentEventState.Open,
        lastUpdated: incident.last_status_change_at,
        updateSequenceNumber: '0'
    };
    return event;
}

function getCloudId(context: unknown) {
    if (context == null || context === undefined || typeof context !== 'object') {
        throw new Error('Invalid context.');
    }

    if (!('installContext' in context) || typeof context['installContext'] !== 'string') {
        throw new Error('Missing installation information (installContext) from context.');
    }

    const site = context['installContext'] as string;
    if (!site.startsWith('ari:cloud:compass::site/')) {
        throw new Error(`Got invalid site id: ${site}`);
    }
    return site.replace('ari:cloud:compass::site/', '');
}
