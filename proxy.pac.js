function FindProxyForURL(url, host) {
    // 本地地址直连
    if (isPlainHostName(host) || 
        shExpMatch(host, "*.local") || 
        isInNet(dnsResolve(host), "10.0.0.0", "255.0.0.0") || 
        isInNet(dnsResolve(host), "172.16.0.0", "255.240.0.0") || 
        isInNet(dnsResolve(host), "192.168.0.0", "255.255.0.0") || 
        isInNet(dnsResolve(host), "127.0.0.0", "255.255.255.0")) {
        return "DIRECT";
    }
    
    // 默认使用SOCKS5代理
    return "SOCKS5 127.0.0.1:1080; SOCKS 127.0.0.1:1080; DIRECT";
}