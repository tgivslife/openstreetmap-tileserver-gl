# TileServer GL

## Installing

The recommended method is to use docker:

    docker build . -t stsdockerhub/tileserver-gl

For detailed installation instructions, see [INSTALL.md](docs/1.INSTALL.md).

## Deployment

Typically, you should use nginx, lighttpd or apache on the frontend. The tileserver-gl server is hidden behind it in
production deployment.

### Nginx Cache

If you have a reverse proxy setup in front of the tileserver you may want to enable caching as it will greatly offload
requests from the application.

Configure the proxy cache path directive to initialize your cache store:

```
  proxy_cache_path /var/cache/nginx/tileserver
                   keys_zone=TileserverCache:50m
                   levels=1:2
                   inactive=2w
                   max_size=10g;
```

Make sure to give proper permissions for the /var/cache/nginx/tileserver folder. Usually nginx is running with www-data
user.
Enable caching on specific proxy pass:

```
  location / {
    include proxy_params; 
    proxy_pass http://127.0.0.1:8080/;

    proxy_cache TileserverCache;
    proxy_cache_valid 200 1w;

    # add_header X-Cache-Status $upstream_cache_status;
  }
```

If you need to confirm whether caching works or not, uncomment the X-Cache-Status header. This will return a header on
response with `HIT` or `MISS` header value which indicates if nginx cached the response or not.

Make sure to clean your cache by removing files in the configured directory after you change your styles or tile
information. You may experiment with the caching values to fit your needs.

More about Nginx caching: https://docs.nginx.com/nginx/admin-guide/content-cache/content-caching/

### Securing

Nginx can be used to add protection via https, password, referrer, IP address restriction, access keys, etc.

### Running behind a proxy or a load-balancer

If you need to run TileServer GL behind a proxy, make sure the proxy sends ``X-Forwarded-*`` headers to the server (most
importantly ``X-Forwarded-Host`` and ``X-Forwarded-Proto``) to ensure the URLs generated inside TileJSON, etc. are using
the desired domain and protocol.

### Nginx Reverse Proxy

An example nginx reverse proxy server configuration for HTTPS connections. It enables caching and CORS.

```
  proxy_cache_path /var/cache/nginx/tileserver
                   keys_zone=TileserverCache:50m 
                   levels=1:2
                   inactive=2w
                   max_size=1g;

  map_hash_bucket_size 128;
  map $http_origin $allow_origin {
      https://www.example.com $http_origin;
      default "";
  }

  server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;

    ssl_certificate         /etc/ssl/www.example.com/cert.pem;
    ssl_certificate_key     /etc/ssl/www.example.com/key.pem;

    server_name www.example.com example.com;

    # Disable root application access. You may want to allow this in development.
    location ~ ^/$ {
      return 404;
    }

    # Disable root application access. You may want to allow this in development.
    location /favicon.ico {
      return 404;
    }

    location / {
      # This include directive sets up required headers for proxy and proxy cache.
      # As well it includes the required ``X-Forwarded-*`` headers for tileserver to properly generate tiles.
      include proxy_params;

      proxy_pass http://127.0.0.1:8080/;

      # Disable default CORS headers
      proxy_hide_header Access-Control-Allow-Origin;

      # Enable proxy cache
      proxy_cache TileserverCache;
      proxy_cache_valid 200 1w;

      # Set our custom CORS
      add_header 'Access-Control-Allow-Origin' $allow_origin;
      
      # If you need to see nginx cache status. Uncomment line below.
      # add_header X-Cache-Status $upstream_cache_status;
    }
  }
```