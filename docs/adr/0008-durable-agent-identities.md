# Represent Agents as durable registered clients

2Brain represents an Agent as a durable registered client identity, while temporary executions remain Agent Runs beneath it. Treating every run as an Agent was rejected because it would make permissions and ownership ambiguous and overwhelm the Agents view; the durable model also aligns with the project's existing OAuth client boundary.
