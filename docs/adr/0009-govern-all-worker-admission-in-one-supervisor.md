# Govern all worker admission in one supervisor

One host-neutral supervisor, protected by an atomic singleton lease in the shared Git directory, admits normal Work Items, resumed Claim Leases, user-authorized retries, and Goal Review through the same Resource Governor. Capacity is the minimum of configured, CPU, memory, load, and provider-quota limits; reduced capacity stops new admission without killing active workers. Failures block their context by default, while goal-wide Input Requests are reserved for invalid planning, unsafe shared state, or unavailable shared infrastructure.
