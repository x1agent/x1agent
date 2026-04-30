{{/*
Common label set. Every resource carries these so cluster-wide queries
("show me everything for this x1agent install") work cleanly.
*/}}
{{- define "x1agent.labels" -}}
app.kubernetes.io/name: x1agent
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
{{- end }}

{{/*
Per-component selector labels. Use the component arg ("api", "app", etc.)
so Service selectors don't accidentally match each other.
*/}}
{{- define "x1agent.selectorLabels" -}}
app.kubernetes.io/name: x1agent
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
Hostname helpers — single source of truth for URL derivation. Templates
must use these instead of hardcoding so a base-domain change is one edit.
*/}}
{{- define "x1agent.appHost" -}}
app.{{ .Values.baseDomain }}
{{- end }}

{{- define "x1agent.apiHost" -}}
api.{{ .Values.baseDomain }}
{{- end }}

{{- define "x1agent.previewHostWildcard" -}}
*.preview.{{ .Values.baseDomain }}
{{- end }}

{{- define "x1agent.natsWsHost" -}}
nats.{{ .Values.baseDomain }}
{{- end }}
