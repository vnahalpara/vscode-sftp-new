export interface VhostOptions {
  hostname: string;
  // Magento root (the cloned site path); web root is <root>/pub
  magentoRoot: string;
  fpmSocket: string;
  mageMode: string;
  ssl?: { certPath: string; keyPath: string };
}

// A self-contained Magento nginx server block (inlined from Magento's nginx.conf.sample so each
// site can fastcgi_pass to its own php-fpm socket without a shared `fastcgi_backend` upstream).
export function magentoVhost(o: VhostOptions): string {
  const listen = o.ssl
    ? `    listen 443 ssl;\n    http2 on;\n    ssl_certificate ${o.ssl.certPath};\n    ssl_certificate_key ${o.ssl.keyPath};`
    : `    listen 80;`;

  const redirect = o.ssl
    ? `server {\n    listen 80;\n    server_name ${o.hostname};\n    return 301 https://$host$request_uri;\n}\n\n`
    : '';

  return `${redirect}server {
${listen}
    server_name ${o.hostname};

    set $MAGE_ROOT ${o.magentoRoot};
    set $MAGE_MODE ${o.mageMode};

    root $MAGE_ROOT/pub;
    index index.php;
    autoindex off;
    charset UTF-8;
    error_page 404 403 = /errors/404.php;

    client_max_body_size 64M;
    fastcgi_read_timeout 1800s;

    location /setup {
        root $MAGE_ROOT;
        location ~ ^/setup/index.php {
            fastcgi_pass   unix:${o.fpmSocket};
            fastcgi_index  index.php;
            fastcgi_param  SCRIPT_FILENAME $realpath_root$fastcgi_script_name;
            include        fastcgi_params;
        }
        location ~ ^/setup/(?!pub/). { deny all; }
        location ~ ^/setup/pub/ { add_header X-Frame-Options "SAMEORIGIN"; }
    }

    location /update {
        root $MAGE_ROOT;
        location ~ ^/update/index.php {
            fastcgi_split_path_info ^(/update/index.php)(/.+)$;
            fastcgi_pass   unix:${o.fpmSocket};
            fastcgi_index  index.php;
            fastcgi_param  PATH_INFO $fastcgi_path_info;
            fastcgi_param  SCRIPT_FILENAME $realpath_root$fastcgi_script_name;
            include        fastcgi_params;
        }
        location ~ ^/update/(?!pub/). { deny all; }
        location ~ ^/update/pub/ { add_header X-Frame-Options "SAMEORIGIN"; }
    }

    location / {
        try_files $uri $uri/ /index.php$is_args$args;
    }

    location /pub/ {
        location ~ ^/pub/media/(downloadable|customer|import|custom_options|theme_customization/.*\\.xml) {
            deny all;
        }
        alias $MAGE_ROOT/pub/;
        add_header X-Frame-Options "SAMEORIGIN";
    }

    location /static/ {
        expires max;
        location ~ ^/static/version\\d*/ {
            rewrite ^/static/version\\d*/(.*)$ /static/$1 last;
        }
        location ~* \\.(ico|jpg|jpeg|png|gif|svg|svgz|webp|avif|js|css|eot|ttf|otf|woff|woff2|html|json|webmanifest|map)$ {
            add_header Cache-Control "public";
            expires +1y;
            try_files $uri $uri/ /static.php$is_args$args;
        }
        add_header X-Frame-Options "SAMEORIGIN";
        try_files $uri $uri/ /static.php$is_args$args;
    }

    location /media/ {
        try_files $uri $uri/ /get.php$is_args$args;
        location ~ ^/media/theme_customization/.*\\.xml { deny all; }
        location ~* \\.(ico|jpg|jpeg|png|gif|svg|svgz|webp|avif|js|css|eot|ttf|otf|woff|woff2)$ {
            add_header Cache-Control "public";
            expires +1y;
            try_files $uri $uri/ /get.php$is_args$args;
        }
        add_header X-Frame-Options "SAMEORIGIN";
    }

    location ~ (index|get|static|report|404|503|health_check)\\.php$ {
        try_files $uri =404;
        fastcgi_pass   unix:${o.fpmSocket};
        fastcgi_buffers 1024 4k;
        fastcgi_param  PHP_FLAG  "session.auto_start=off \\n suhosin.session.cryptua=off";
        fastcgi_param  PHP_VALUE "memory_limit=2048M \\n max_execution_time=1800";
        fastcgi_read_timeout 1800s;
        fastcgi_connect_timeout 600s;
        fastcgi_param  MAGE_MODE $MAGE_MODE;
        fastcgi_index  index.php;
        fastcgi_param  SCRIPT_FILENAME $realpath_root$fastcgi_script_name;
        include        fastcgi_params;
    }

    location ~* (\\.php$|\\.phtml$|\\.htaccess$|\\.htpasswd$|\\.git) {
        deny all;
    }
}
`;
}

export interface PoolOptions {
  name: string;
  socket: string;
  owner: string;
}

// A dedicated php-fpm pool with a per-site socket and Magento-friendly limits.
export function phpFpmPool(o: PoolOptions): string {
  return `[${o.name}]
listen = ${o.socket}
listen.owner = ${o.owner}
listen.mode = 0660
pm = dynamic
pm.max_children = 16
pm.start_servers = 3
pm.min_spare_servers = 2
pm.max_spare_servers = 6
request_terminate_timeout = 1800
catch_workers_output = yes
php_admin_value[memory_limit] = 2048M
php_admin_value[max_execution_time] = 1800
php_admin_value[realpath_cache_size] = 10M
php_admin_value[realpath_cache_ttl] = 7200
`;
}
